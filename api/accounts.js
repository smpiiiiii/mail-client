/**
 * メールアカウント管理API
 * GET  /api/accounts — アカウント一覧
 * POST /api/accounts — 追加 / 接続テスト / 削除
 */
const { getRedis, getUser, encrypt, cors, genId } = require('./helpers');
const { ImapFlow } = require('imapflow');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: '認証が必要です' });

  const redis = getRedis();

  // --- アカウント一覧 ---
  if (req.method === 'GET') {
    const accountIds = await redis.smembers(`mail:user:${user.id}:accounts`) || [];
    const accounts = [];
    for (const id of accountIds) {
      const acc = await redis.hgetall(`mail:account:${id}`);
      if (acc && acc.id) {
        accounts.push({
          id: acc.id,
          email: acc.email,
          imapHost: acc.imapHost,
          imapPort: parseInt(acc.imapPort),
          lastSynced: acc.lastSynced || null
        });
      }
    }
    return res.json({ accounts });
  }

  // --- アカウント操作 ---
  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { action, email, imapHost, imapPort, password, accountId } = body;

    // IMAPプロバイダーのプリセット（ホスト自動入力用）
    const presets = {
      'gmail.com': { host: 'imap.gmail.com', port: 993 },
      'yahoo.co.jp': { host: 'imap.mail.yahoo.co.jp', port: 993 },
      'outlook.com': { host: 'outlook.office365.com', port: 993 },
      'hotmail.com': { host: 'outlook.office365.com', port: 993 },
      'icloud.com': { host: 'imap.mail.me.com', port: 993 },
    };

    const domain = email ? email.split('@')[1] : '';
    const host = imapHost || (presets[domain]?.host) || '';
    const port = imapPort || (presets[domain]?.port) || 993;

    // --- 接続テスト or 追加 ---
    if (action === 'test' || action === 'add') {
      if (!email || !password || !host) {
        return res.status(400).json({ error: 'メール、パスワード、IMAPホストが必要です' });
      }

      const client = new ImapFlow({
        host,
        port: parseInt(port),
        secure: true,
        auth: { user: email, pass: password },
        logger: false
      });

      try {
        await client.connect();
        await client.logout();
      } catch (e) {
        return res.status(400).json({ error: `接続失敗: ${e.message}` });
      }

      if (action === 'test') {
        return res.json({ success: true, message: '✅ 接続成功！' });
      }

      // アカウント保存
      const id = genId();
      const encPassword = encrypt(password);
      await redis.hset(`mail:account:${id}`, {
        id, userId: user.id, email,
        imapHost: host, imapPort: port.toString(),
        encPassword,
        lastSynced: '', lastSyncedUid: '0'
      });
      await redis.sadd(`mail:user:${user.id}:accounts`, id);

      return res.json({
        success: true,
        message: 'アカウントを追加しました',
        account: { id, email, imapHost: host, imapPort: port }
      });
    }

    // --- アカウント削除 ---
    if (action === 'delete') {
      if (!accountId) return res.status(400).json({ error: 'accountIdが必要です' });
      await redis.del(`mail:account:${accountId}`);
      await redis.srem(`mail:user:${user.id}:accounts`, accountId);
      return res.json({ success: true, message: 'アカウントを削除しました' });
    }

    return res.status(400).json({ error: '不正なアクション' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
