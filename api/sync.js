/**
 * IMAP同期API
 * POST /api/sync
 * 「今取り込む」ボタンで呼ばれる。IMAPで新着メールを取得してRedisに保存。
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
    const BATCH_SIZE = 30; // Vercelタイムアウト内で処理できる件数
    const startTime = Date.now();
    const TIMEOUT_MS = 50000; // 50秒で切り上げ

    try {
      // 最後に同期したUID以降の新着メールを取得
      const lastUid = parseInt(account.lastSyncedUid) || 0;
      const range = lastUid > 0 ? `${lastUid + 1}:*` : '1:*';

      let maxUid = lastUid;

      for await (const msg of client.fetch(range, {
        uid: true,
        envelope: true,
        bodyStructure: true,
        source: true
      }, { uid: true })) {
        // タイムアウトチェック
        if (Date.now() - startTime > TIMEOUT_MS) break;
        if (synced >= BATCH_SIZE) break;

        const parsed = await simpleParser(msg.source);

        const emailId = genId();
        const timestamp = parsed.date ? parsed.date.getTime() : Date.now();

        // 添付ファイル情報（メタデータのみ保存、実データは抽出時にIMAPから再取得）
        const attachments = (parsed.attachments || []).map(att => ({
          filename: att.filename || '不明',
          contentType: att.contentType || 'application/octet-stream',
          size: att.size || 0
        }));

        // 本文プレビュー
        const bodyText = parsed.text || '';
        const htmlBody = parsed.html || '';
        const bodyPreview = (bodyText || htmlBody.replace(/<[^>]+>/g, ' ')).substring(0, 200).trim();

        // メールをRedisに保存
        await redis.hset(`mail:email:${emailId}`, {
          id: emailId,
          accountId,
          messageId: parsed.messageId || '',
          uid: msg.uid.toString(),
          subject: parsed.subject || '(件名なし)',
          from: parsed.from?.text || '',
          fromName: parsed.from?.value?.[0]?.name || '',
          to: parsed.to?.text || '',
          date: parsed.date?.toISOString() || new Date().toISOString(),
          timestamp: timestamp.toString(),
          bodyPreview,
          bodyText: bodyText.substring(0, 50000),
          bodyHtml: htmlBody.substring(0, 100000),
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
