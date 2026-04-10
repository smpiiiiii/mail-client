/**
 * メール一覧・詳細API
 * GET /api/emails          — メール一覧（ページネーション）
 * GET /api/emails?id=xxx   — メール詳細（本文はIMAPからオンデマンド取得）
 */
const { getRedis, getUser, decrypt, cors } = require('./helpers');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// メール本文取得にIMAP再接続が必要なため60秒に延長
module.exports.maxDuration = 60;

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: '認証が必要です' });

  const redis = getRedis();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const emailId = url.searchParams.get('id');

  // --- メール詳細 ---
  if (emailId) {
    const email = await redis.hgetall(`mail:email:${emailId}`);
    if (!email || !email.id) {
      return res.status(404).json({ error: 'メールが見つかりません' });
    }

    // 既読フラグを設定
    if (email.isRead !== '1') {
      await redis.hset(`mail:email:${emailId}`, { isRead: '1' });
    }

    // 本文がまだ取得されていない場合、IMAPからオンデマンド取得
    if (!email.bodyText && !email.bodyHtml) {
      try {
        const account = await redis.hgetall(`mail:account:${email.accountId}`);
        if (account && account.encPassword) {
          const password = decrypt(account.encPassword);
          const client = new ImapFlow({
            host: account.imapHost,
            port: parseInt(account.imapPort),
            secure: true,
            auth: { user: account.email, pass: password },
            logger: false
          });

          await client.connect();
          const lock = await client.getMailboxLock('INBOX');
          try {
            for await (const msg of client.fetch(email.uid, {
              uid: true,
              source: true
            }, { uid: true })) {
              const parsed = await simpleParser(msg.source);
              email.bodyText = (parsed.text || '').substring(0, 50000);
              email.bodyHtml = (parsed.html || '').substring(0, 100000);
              email.bodyPreview = (email.bodyText || email.bodyHtml.replace(/<[^>]+>/g, ' ')).substring(0, 200);

              // Redisにキャッシュ（次回はIMAPに接続不要）
              await redis.hset(`mail:email:${emailId}`, {
                bodyText: email.bodyText,
                bodyHtml: email.bodyHtml,
                bodyPreview: email.bodyPreview
              });
            }
          } finally {
            lock.release();
          }
          await client.logout();
        }
      } catch (e) {
        console.error('本文取得エラー:', e.message);
        email.bodyText = '(本文の取得に失敗しました)';
      }
    }

    return res.json({
      email: {
        ...email,
        hasAttachment: email.hasAttachment === '1',
        isRead: true,
        extracted: email.extracted === '1',
        attachments: JSON.parse(email.attachments || '[]')
      }
    });
  }

  // --- メール一覧 ---
  const page = parseInt(url.searchParams.get('page')) || 1;
  const per = parseInt(url.searchParams.get('per')) || 20;
  const accountId = url.searchParams.get('accountId');

  // アカウント別 or ユーザー全体
  const key = accountId
    ? `mail:account:${accountId}:emails`
    : `mail:user:${user.id}:emails`;

  const total = await redis.zcard(key) || 0;
  const start = (page - 1) * per;
  const end = start + per - 1;

  // 新しい順（スコア降順）で取得
  const emailIds = await redis.zrange(key, start, end, { rev: true }) || [];

  const emails = [];
  for (const id of emailIds) {
    const email = await redis.hgetall(`mail:email:${id}`);
    if (email && email.id) {
      emails.push({
        id: email.id,
        subject: email.subject,
        from: email.from,
        fromName: email.fromName,
        date: email.date,
        bodyPreview: email.bodyPreview || '',
        hasAttachment: email.hasAttachment === '1',
        isRead: email.isRead === '1',
        extracted: email.extracted === '1',
        docId: email.docId || null,
        attachments: JSON.parse(email.attachments || '[]')
      });
    }
  }

  return res.json({
    emails,
    total,
    page,
    pages: Math.ceil(total / per)
  });
};

