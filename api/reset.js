/**
 * デバッグ用: メールデータリセットAPI
 * POST /api/reset — ユーザーのメールデータを全削除（再同期用）
 */
const { getRedis, getUser, cors } = require('./helpers');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: '認証が必要です' });

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

  // アカウント別のソートセットもクリア
  const accountIds = await redis.smembers(`mail:user:${user.id}:accounts`) || [];
  for (const accId of accountIds) {
    await redis.del(`mail:account:${accId}:emails`);
    // lastSyncedUidをリセット
    await redis.hset(`mail:account:${accId}`, { lastSyncedUid: '0', lastSynced: '' });
  }

  return res.json({
    success: true,
    deleted: emailIds.length,
    message: `${emailIds.length}件のメールデータを削除しました。再同期してください。`
  });
};
