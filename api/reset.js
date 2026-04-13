/**
 * メールデータリセットAPI
 * POST /api/reset — ユーザーのメールデータを全削除（再同期用）
 * パイプラインで高速削除
 */
const { getRedis, getUser, cors } = require('./helpers');

// タイムアウト延長
module.exports.maxDuration = 30;

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POSTのみ対応' });

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: '認証が必要です' });

  const redis = getRedis();

  // メールID一覧取得
  const emailIds = await redis.zrange(`mail:user:${user.id}:emails`, 0, -1) || [];

  // パイプラインでバッチ削除（タイムアウト防止）
  if (emailIds.length > 0) {
    const batchSize = 100;
    for (let i = 0; i < emailIds.length; i += batchSize) {
      const batch = emailIds.slice(i, i + batchSize);
      const p = redis.pipeline();
      for (const id of batch) {
        p.del(`mail:email:${id}`);
      }
      await p.exec();
    }
    await redis.del(`mail:user:${user.id}:emails`);
  }

  // アカウント別のソートセットもクリア＋lastSyncedUidリセット
  const accountIds = await redis.smembers(`mail:user:${user.id}:accounts`) || [];
  for (const accId of accountIds) {
    await redis.del(`mail:account:${accId}:emails`);
    await redis.hset(`mail:account:${accId}`, { lastSyncedUid: '0', lastSynced: '' });
  }

  // 書類データもバッチ削除
  const docIds = await redis.zrange(`mail:user:${user.id}:docs`, 0, -1) || [];
  if (docIds.length > 0) {
    const p = redis.pipeline();
    for (const id of docIds) {
      p.del(`mail:doc:${id}`);
    }
    await p.exec();
    await redis.del(`mail:user:${user.id}:docs`);
  }

  return res.json({
    success: true,
    deleted: emailIds.length,
    docsDeleted: docIds.length,
    message: `${emailIds.length}件のメール + ${docIds.length}件の書類を削除しました`
  });
};
