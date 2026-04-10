/**
 * 認証API
 * POST /api/auth
 * action: "register" | "login"
 */
const { getRedis, signToken, cors } = require('./helpers');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { action, email, password } = body;
  const redis = getRedis();

  if (!email || !password) {
    return res.status(400).json({ error: 'メールアドレスとパスワードを入力してください' });
  }

  // --- 新規登録 ---
  if (action === 'register') {
    const exists = await redis.hgetall(`mail:user:${email}`);
    if (exists && exists.id) {
      return res.status(400).json({ error: 'このメールアドレスは既に登録されています' });
    }

    const id = crypto.randomBytes(12).toString('hex');
    const passwordHash = await bcrypt.hash(password, 10);

    await redis.hset(`mail:user:${email}`, {
      id, email, passwordHash,
      plan: 'free',
      createdAt: new Date().toISOString()
    });
    await redis.sadd('mail:users', email);

    const token = signToken({ id, email });
    return res.json({ success: true, token, user: { id, email } });
  }

  // --- ログイン ---
  if (action === 'login') {
    const user = await redis.hgetall(`mail:user:${email}`);
    if (!user || !user.id) {
      return res.status(401).json({ error: 'メールアドレスまたはパスワードが正しくありません' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'メールアドレスまたはパスワードが正しくありません' });
    }

    const token = signToken({ id: user.id, email });
    return res.json({ success: true, token, user: { id: user.id, email } });
  }

  return res.status(400).json({ error: '不正なアクション' });
};
