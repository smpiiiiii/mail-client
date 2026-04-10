/**
 * IMAP同期API
 * POST /api/sync
 * 「今取り込む」ボタンで呼ばれる。IMAPで新着メールを取得してRedisに保存。
 * 軽量版: envelope（ヘッダー）のみ取得し、本文は閲覧時にオンデマンド取得。
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
  const { accountId } = body;

  const redis = getRedis();
  const account = await redis.hgetall(`mail:account:${accountId}`);

  if (!account || account.userId !== user.id) {
    return res.status(404).json({ error: 'アカウントが見つかりません' });
  }

  const password = decrypt(account.encPassword);

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
    const BATCH_SIZE = 20; // 1回の同期で取得する最大件数
    const startTime = Date.now();
    const TIMEOUT_MS = 40000; // 40秒で切り上げ

    try {
      const lastUid = parseInt(account.lastSyncedUid) || 0;
      let maxUid = lastUid;

      let uidsToFetch;
      if (lastUid > 0) {
        // 2回目以降: 前回以降のUIDを取得
        uidsToFetch = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
        // IMAPの仕様でlastUid自体も含まれる場合があるので除外
        uidsToFetch = uidsToFetch.filter(u => u > lastUid);
      } else {
        // 初回: 過去30日のメールをSEARCHで取得（確実に最新メール）
        const since = new Date();
        since.setDate(since.getDate() - 30);
        uidsToFetch = await client.search({ since }, { uid: true });
      }

      if (uidsToFetch.length === 0) {
        lock.release();
        await client.logout();
        return res.json({ success: true, synced: 0, message: '新しいメールはありません' });
      }

      // 最新のものから取得（降順ソート→最新BATCH_SIZE件）
      uidsToFetch.sort((a, b) => b - a);
      const targetUids = uidsToFetch.slice(0, BATCH_SIZE);
      const uidRange = targetUids.join(',');

      for await (const msg of client.fetch(uidRange, {
        uid: true, envelope: true, bodyStructure: true
      }, { uid: true })) {
        // タイムアウトチェック
        if (Date.now() - startTime > TIMEOUT_MS) break;
        if (synced >= BATCH_SIZE) break;

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

        // ソートセットに追加（スコア = タイムスタンプ、新しい順で取得可能）
        await redis.zadd(`mail:account:${accountId}:emails`, {
          score: timestamp,
          member: emailId
        });
        await redis.zadd(`mail:user:${user.id}:emails`, {
          score: timestamp,
          member: emailId
        });

        if (msg.uid > maxUid) maxUid = msg.uid;
        synced++;
      }

      // 最後のUIDを更新（次回同期の起点）
      if (maxUid > lastUid) {
        await redis.hset(`mail:account:${accountId}`, {
          lastSyncedUid: maxUid.toString(),
          lastSynced: new Date().toISOString()
        });
      }
    } finally {
      lock.release();
    }

    await client.logout();

    return res.json({
      success: true,
      synced,
      message: synced > 0 ? `${synced}件のメールを取得しました` : '新しいメールはありません'
    });
  } catch (e) {
    console.error('同期エラー:', e);
    return res.status(500).json({ error: `同期エラー: ${e.message}` });
  }
};
