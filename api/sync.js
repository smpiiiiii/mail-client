/**
 * IMAP同期API
 * POST /api/sync
 * 「今取り込む」ボタンで呼ばれる。IMAPで新着メールを取得してRedisに保存。
 * 軽量版: envelope（ヘッダー）のみ取得し、本文は閲覧時にオンデマンド取得。
 * month パラメータで月単位の取得が可能（例: "2026-04"）
 */
const { getRedis, getUser, decrypt, cors, genId } = require('./helpers');
const { ImapFlow } = require('imapflow');

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

    try {
      const lastUid = parseInt(account.lastSyncedUid) || 0;
      let maxUid = lastUid;

      let uidsToFetch;

      if (month) {
        // 月指定: その月の初日〜末日のメールを取得
        const [year, mon] = month.split('-').map(Number);
        const since = new Date(year, mon - 1, 1);
        const before = new Date(year, mon, 1); // 翌月1日
        uidsToFetch = await client.search({ since, before }, { uid: true });
      } else if (lastUid > 0) {
        // 差分同期: 前回以降のUIDを取得
        uidsToFetch = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
        uidsToFetch = uidsToFetch.filter(u => u > lastUid);
      } else {
        // 初回: 過去30日のメール
        const since = new Date();
        since.setDate(since.getDate() - 30);
        uidsToFetch = await client.search({ since }, { uid: true });
      }

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
        uid: true, envelope: true, bodyStructure: true
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

        // メールをRedisに保存（本文なし — 閲覧時にIMAPから取得）
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
          bodyPreview: '',
          bodyText: '',
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
