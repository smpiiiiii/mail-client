/**
 * デバッグ用: メールデータリセットAPI
 * GET/POST /api/reset — ユーザーのメールデータを全削除（再同期用）
 * GETの場合はクエリパラメータ ?token=xxx で認証
 */
const { getRedis, getUser, verifyToken, cors } = require('./helpers');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 認証: POST→Authorizationヘッダー、GET→クエリパラメータ
  let user;
  if (req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    if (token) user = verifyToken(token);
  } else {
    user = getUser(req);
  }

  if (!user) {
    return res.status(401).json({ error: '認証が必要です。?token=xxx を付けてください' });
  }

  const redis = getRedis();

  // ユーザーのメールID一覧を取得
  const emailIds = await redis.zrange(`mail:user:${user.id}:emails`, 0, -1) || [];

  // 各メールデータを削除
  for (const id of emailIds) {
    await redis.del(`mail:email:${id}`);
  }

  // ソートセットをクリア
  if (emailIds.length > 0) {
    await redis.del(`mail:user:${user.id}:emails`);
  }

  // アカウント別のソートセットもクリア＋lastSyncedUidリセット
  const accountIds = await redis.smembers(`mail:user:${user.id}:accounts`) || [];
  for (const accId of accountIds) {
    await redis.del(`mail:account:${accId}:emails`);
    await redis.hset(`mail:account:${accId}`, { lastSyncedUid: '0', lastSynced: '' });
  }

  // 書類データもクリア
  const docIds = await redis.zrange(`mail:user:${user.id}:docs`, 0, -1) || [];
  for (const id of docIds) {
    await redis.del(`mail:doc:${id}`);
  }
  if (docIds.length > 0) {
    await redis.del(`mail:user:${user.id}:docs`);
  }

  const result = {
    success: true,
    deleted: emailIds.length,
    docsDeleted: docIds.length,
    message: `${emailIds.length}件のメール + ${docIds.length}件の書類データを削除しました。再同期してください。`
  };

  // GETの場合はHTMLで見やすく表示
  if (req.method === 'GET') {
    return res.send(`<html><body style="font-family:sans-serif;padding:40px;background:#111;color:#eee;">
      <h1>✅ リセット完了</h1>
      <p>${result.message}</p>
      <p><a href="/" style="color:#7c3aed;">→ アプリに戻る</a></p>
    </body></html>`);
  }

  return res.json(result);
};
