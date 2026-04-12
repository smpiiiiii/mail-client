/**
 * IMAP同期API
 * POST /api/sync
 * 「今取り込む」ボタンで呼ばれる。IMAPで新着メールを取得してRedisに保存。
 * 軽量版: envelope（ヘッダー）のみ取得し、本文は閲覧時にオンデマンド取得。
 * month パラメータで月単位の取得が可能（例: "2026-04"）
 */
const { getRedis, getUser, decrypt, cors, genId } = require('./helpers');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// IMAP同期は最大60秒
module.exports.maxDuration = 60;

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: '認証が必要です' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { accountId, month } = body; // month: "2026-04" 形式（任意）

  const redis = getRedis();
  const account = await redis.hgetall(`mail:account:${accountId}`);

  if (!account || account.userId !== user.id) {
    return res.status(404).json({ error: 'アカウントが見つかりません' });
  }

  // IMAP接続
  let password;
  try {
    password = decrypt(account.encPassword);
  } catch {
    return res.status(400).json({ error: 'パスワードの復号に失敗しました。アカウントを再登録してください。' });
  }

  const client = new ImapFlow({
    host: account.imapHost,
    port: parseInt(account.imapPort),
    secure: true,
    auth: { user: account.email, pass: password },
    logger: false
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let synced = 0;
    const BATCH_SIZE = 500; // 1回の同期で取得する最大件数（ヘッダーのみなので大量OK）
    const startTime = Date.now();
    const TIMEOUT_MS = 45000; // 45秒で切り上げ

    let uidsToFetch;
    try {
      const lastUid = parseInt(account.lastSyncedUid) || 0;
      let maxUid = lastUid;

      // 財務系キーワード（IMAP SEARCH用）
      const FINANCE_KEYWORDS = [
        '請求', '領収', '決済', '支払', '振込', '入金',
        '注文', '購入', '明細', '引き落とし', '料金',
        '納品', '見積', '代金',
        'invoice', 'receipt', 'payment', 'billing', 'order'
      ];

      // 各キーワードで IMAP SEARCH を実行し、UIDを集める
      const uidSet = new Set();
      const dateFilter = {};
      if (month) {
        const [year, mon] = month.split('-').map(Number);
        dateFilter.since = new Date(year, mon - 1, 1);
        dateFilter.before = new Date(year, mon, 1);
      } else if (lastUid > 0) {
        // 差分同期: UID指定（キーワード検索と組み合わせ）
      } else {
        const since = new Date();
        since.setDate(since.getDate() - 90); // 過去90日に拡大（フィルタで絞るので多めでOK）
        dateFilter.since = since;
      }

      for (const kw of FINANCE_KEYWORDS) {
        try {
          // 件名 OR 本文でキーワード検索
          const query = { ...dateFilter, or: [{ subject: kw }, { body: kw }] };
          if (lastUid > 0 && !month) {
            query.uid = `${lastUid + 1}:*`;
          }
          const results = await client.search(query, { uid: true });
          for (const uid of results) {
            if (lastUid > 0 && uid <= lastUid && !month) continue;
            uidSet.add(uid);
          }
        } catch (searchErr) {
          // 一部キーワードの検索失敗は無視して続行
          console.log(`IMAP検索スキップ: "${kw}" - ${searchErr.message}`);
        }
      }

      uidsToFetch = Array.from(uidSet);
      console.log(`📬 IMAP検索: ${FINANCE_KEYWORDS.length}キーワードで ${uidsToFetch.length}件ヒット`);

      if (uidsToFetch.length === 0) {
        lock.release();
        await client.logout();
        return res.json({ success: true, synced: 0, message: month ? `${month}のメールはありません` : '新しいメールはありません' });
      }

      // 最新のものから取得（降順ソート→最新BATCH_SIZE件）
      uidsToFetch.sort((a, b) => b - a);
      const targetUids = uidsToFetch.slice(0, BATCH_SIZE);
      const uidRange = targetUids.join(',');

      // 既存メールのUID一覧を取得（重複防止）
      const existingIds = await redis.zrange(`mail:account:${accountId}:emails`, 0, -1) || [];
      const existingUids = new Set();
      for (const eid of existingIds) {
        const u = await redis.hget(`mail:email:${eid}`, 'uid');
        if (u) existingUids.add(String(u));
      }

      for await (const msg of client.fetch(uidRange, {
        uid: true, envelope: true, bodyStructure: true,
        source: true // メール全文を取得
      }, { uid: true })) {
        // タイムアウトチェック
        if (Date.now() - startTime > TIMEOUT_MS) break;
        if (synced >= BATCH_SIZE) break;

        // UID重複チェック（既に保存済みならスキップ）
        if (existingUids.has(String(msg.uid))) continue;

        const env = msg.envelope;
        const emailId = genId();
        const timestamp = env.date ? new Date(env.date).getTime() : Date.now();

        // 添付ファイル情報をbodyStructureから取得
        const attachments = [];
        function walkParts(part) {
          if (part.disposition === 'attachment' || (part.type && part.subtype && part.size > 0 && part.disposition)) {
            attachments.push({
              filename: (part.dispositionParameters && part.dispositionParameters.filename) || (part.parameters && part.parameters.name) || '添付ファイル',
              contentType: `${part.type}/${part.subtype}`,
              size: part.size || 0
            });
          }
          if (part.childNodes) part.childNodes.forEach(walkParts);
        }
        if (msg.bodyStructure) walkParts(msg.bodyStructure);

        // 差出人情報
        const fromAddr = env.from && env.from[0] ? env.from[0] : {};
        const fromText = fromAddr.address || '';
        const fromName = fromAddr.name || '';
        const toAddr = env.to && env.to[0] ? env.to[0] : {};

        // メール本文をmailparserで正確に抽出（日本語エンコーディング対応）
        let bodyText = '';
        let bodyPreview = '';
        if (msg.source) {
          try {
            const parsed = await simpleParser(msg.source);
            bodyText = (parsed.text || '').substring(0, 8000);
            if (!bodyText && parsed.html) {
              // テキスト部分がない場合、HTMLからテキスト抽出
              bodyText = parsed.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 8000);
            }
            bodyPreview = bodyText.substring(0, 200);
          } catch (parseErr) {
            console.error(`メール解析エラー (UID:${msg.uid}):`, parseErr.message);
          }
        }

        // メールをRedisに保存（本文も含む）
        await redis.hset(`mail:email:${emailId}`, {
          id: emailId,
          accountId,
          messageId: env.messageId || '',
          uid: msg.uid.toString(),
          subject: env.subject || '(件名なし)',
          from: fromText,
          fromName: fromName,
          to: toAddr.address || '',
          date: env.date ? new Date(env.date).toISOString() : new Date().toISOString(),
          timestamp: timestamp.toString(),
          bodyPreview: bodyPreview,
          bodyText: bodyText,
          bodyHtml: '',
          hasAttachment: attachments.length > 0 ? '1' : '0',
          attachments: JSON.stringify(attachments),
          isRead: '0',
          extracted: '0'
        });

        // ソートセットに追加
        await redis.zadd(`mail:account:${accountId}:emails`, { score: timestamp, member: emailId });
        await redis.zadd(`mail:user:${user.id}:emails`, { score: timestamp, member: emailId });

        if (msg.uid > maxUid) maxUid = msg.uid;
        synced++;
      }

      // 月指定でない場合のみlastSyncedUidを更新
      if (!month && maxUid > lastUid) {
        await redis.hset(`mail:account:${accountId}`, {
          lastSyncedUid: maxUid.toString(),
          lastSynced: new Date().toISOString()
        });
      } else if (month) {
        // 月指定の場合も最終同期時刻だけ更新
        await redis.hset(`mail:account:${accountId}`, {
          lastSynced: new Date().toISOString()
        });
      }

      lock.release();
    } catch (e) {
      console.error('同期内部エラー:', e.message);
      try { lock.release(); } catch {}
      throw e;
    }

    await client.logout();
    const remaining = month ? '' : '';
    return res.json({
      success: true,
      synced,
      total: uidsToFetch ? uidsToFetch.length : synced,
      message: `${synced}件のメールを取得しました`
    });
  } catch (e) {
    console.error('同期エラー:', e);
    try { await client.logout(); } catch {}
    return res.status(500).json({ error: `同期エラー: ${e.message}` });
  }
};
