/**
 * 認証API
 * POST /api/auth
 * action: "send-code"    — 新規登録用：認証コードをメール送信
 * action: "register"     — 認証コード確認＋ユーザー作成
 * action: "login"        — ログイン
 * action: "send-reset"   — パスワードリセット用：コード送信
 * action: "reset-password" — 新パスワードを設定
 */
const { getRedis, signToken, cors, sendEmail, genCode } = require('./helpers');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { action, email, password, code } = body;
  const redis = getRedis();

  // ========================================
  // 新規登録: ステップ1 — 認証コード送信
  // ========================================
  if (action === 'send-code') {
    if (!email) return res.status(400).json({ error: 'メールアドレスを入力してください' });

    // 既存ユーザーチェック
    const exists = await redis.hgetall(`mail:user:${email}`);
    if (exists && exists.id) {
      return res.status(400).json({ error: 'このメールアドレスは既に登録されています' });
    }

    // 6桁コード生成＆Redis保存（10分有効）
    const verifyCode = genCode();
    await redis.set(`mail:verify:${email}`, verifyCode, { ex: 600 });

    // メール送信
    try {
      await sendEmail(email, '【MailExtract】メールアドレスの確認',
        `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:30px;">
          <h2 style="color:#7c3aed;">📧 MailExtract</h2>
          <p>以下の認証コードを入力して登録を完了してください。</p>
          <div style="background:#f3f0ff;border-radius:12px;padding:20px;text-align:center;margin:20px 0;">
            <span style="font-size:2rem;font-weight:700;letter-spacing:8px;color:#7c3aed;">${verifyCode}</span>
          </div>
          <p style="color:#888;font-size:0.85rem;">※このコードは10分間有効です。</p>
        </div>`
      );
    } catch (e) {
      console.error('メール送信エラー:', e);
      return res.status(500).json({ error: 'メール送信に失敗しました。しばらく後に再試行してください。' });
    }

    return res.json({ success: true, message: '認証コードをメールに送信しました' });
  }

  // ========================================
  // 新規登録: ステップ2 — コード確認＋ユーザー作成
  // ========================================
  if (action === 'register') {
    if (!email || !password || !code) {
      return res.status(400).json({ error: 'メール、パスワード、認証コードを入力してください' });
    }

    // コード検証
    const savedCode = await redis.get(`mail:verify:${email}`);
    if (!savedCode || savedCode !== code) {
      return res.status(400).json({ error: '認証コードが正しくありません。再度送信してください。' });
    }

    // 既存チェック
    const exists = await redis.hgetall(`mail:user:${email}`);
    if (exists && exists.id) {
      return res.status(400).json({ error: 'このメールアドレスは既に登録されています' });
    }

    // ユーザー作成
    const id = crypto.randomBytes(12).toString('hex');
    const passwordHash = await bcrypt.hash(password, 10);

    await redis.hset(`mail:user:${email}`, {
      id, email, passwordHash,
      plan: 'free',
      verified: '1',
      createdAt: new Date().toISOString()
    });
    await redis.sadd('mail:users', email);

    // コード削除
    await redis.del(`mail:verify:${email}`);

    const token = signToken({ id, email });
    return res.json({ success: true, token, user: { id, email } });
  }

  // ========================================
  // ログイン
  // ========================================
  if (action === 'login') {
    if (!email || !password) {
      return res.status(400).json({ error: 'メールアドレスとパスワードを入力してください' });
    }

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

  // ========================================
  // パスワードリセット: ステップ1 — コード送信
  // ========================================
  if (action === 'send-reset') {
    if (!email) return res.status(400).json({ error: 'メールアドレスを入力してください' });

    const user = await redis.hgetall(`mail:user:${email}`);
    if (!user || !user.id) {
      // セキュリティ上、存在しないメールでも成功メッセージを返す
      return res.json({ success: true, message: 'リセットコードを送信しました（登録済みの場合）' });
    }

    const resetCode = genCode();
    await redis.set(`mail:reset:${email}`, resetCode, { ex: 600 });

    try {
      await sendEmail(email, '【MailExtract】パスワードリセット',
        `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:30px;">
          <h2 style="color:#7c3aed;">📧 MailExtract</h2>
          <p>パスワードリセットのリクエストを受け付けました。</p>
          <p>以下のコードを入力して新しいパスワードを設定してください。</p>
          <div style="background:#f3f0ff;border-radius:12px;padding:20px;text-align:center;margin:20px 0;">
            <span style="font-size:2rem;font-weight:700;letter-spacing:8px;color:#7c3aed;">${resetCode}</span>
          </div>
          <p style="color:#888;font-size:0.85rem;">※このコードは10分間有効です。心当たりがない場合は無視してください。</p>
        </div>`
      );
    } catch (e) {
      console.error('リセットメール送信エラー:', e);
      return res.status(500).json({ error: 'メール送信に失敗しました' });
    }

    return res.json({ success: true, message: 'リセットコードを送信しました' });
  }

  // ========================================
  // パスワードリセット: ステップ2 — 新パスワード設定
  // ========================================
  if (action === 'reset-password') {
    if (!email || !code || !password) {
      return res.status(400).json({ error: 'メール、コード、新しいパスワードを入力してください' });
    }

    const savedCode = await redis.get(`mail:reset:${email}`);
    if (!savedCode || savedCode !== code) {
      return res.status(400).json({ error: 'リセットコードが正しくありません' });
    }

    const user = await redis.hgetall(`mail:user:${email}`);
    if (!user || !user.id) {
      return res.status(400).json({ error: 'ユーザーが見つかりません' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await redis.hset(`mail:user:${email}`, { passwordHash });
    await redis.del(`mail:reset:${email}`);

    return res.json({ success: true, message: 'パスワードを再設定しました。ログインしてください。' });
  }

  return res.status(400).json({ error: '不正なアクション' });
};
