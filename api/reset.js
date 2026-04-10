/**
 * メールデータリセットAPI
 * POST /api/reset — ユーザーのメールデータを全削除（再同期用）
 */
const { getRedis, getUser, cors } = require('./helpers');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POSTのみ対応' });

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

  return res.json({
    success: true,
    deleted: emailIds.length,
    docsDeleted: docIds.length,
    message: `${emailIds.length}件のメール + ${docIds.length}件の書類データを削除しました`
  });
};
