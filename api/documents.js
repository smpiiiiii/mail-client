/**
 * 書類一覧・CSVエクスポートAPI
 * GET /api/documents         — 書類一覧（フィルタ・集計付き）
 * GET /api/documents?format=csv — CSVダウンロード
 */
const { getRedis, getUser, cors } = require('./helpers');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: '認証が必要です' });

  const redis = getRedis();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const format = url.searchParams.get('format');
  const month = url.searchParams.get('month'); // YYYY-MM
  const type = url.searchParams.get('type');   // 請求書 | 領収書 | all

  // 全ドキュメント取得（新しい順）
  const docIds = await redis.zrange(`mail:user:${user.id}:docs`, 0, -1, { rev: true }) || [];

  let documents = [];
  for (const id of docIds) {
    const doc = await redis.hgetall(`mail:doc:${id}`);
    if (doc && doc.id) {
      try {
        doc.items = typeof doc.items === 'string' ? JSON.parse(doc.items) : (doc.items || []);
      } catch { doc.items = []; }
      doc.amount = parseInt(doc.amount) || 0;
      doc.amountEx = parseInt(doc.amountEx) || 0;
      doc.tax = parseInt(doc.tax) || 0;
      doc.confidence = parseFloat(doc.confidence) || 0;
      documents.push(doc);
    }
  }

  // --- フィルタ ---
  if (month) {
    documents = documents.filter(d => d.date && d.date.startsWith(month));
  }
  if (type && type !== 'all') {
    documents = documents.filter(d => d.type === type);
  }

  // --- CSVエクスポート ---
  if (format === 'csv') {
    const bom = '\uFEFF'; // Excel日本語対応
    const header = '種別,取引先,日付,金額(税込),税抜,消費税,品目,信頼度,メール件名\n';
    const rows = documents.map(d =>
      [
        d.type,
        `"${(d.vendor || '').replace(/"/g, '""')}"`,
        d.date,
        d.amount,
        d.amountEx,
        d.tax,
        `"${(d.items || []).join(' / ')}"`,
        d.confidence,
        `"${(d.emailSubject || '').replace(/"/g, '""')}"`
      ].join(',')
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=documents_${month || 'all'}.csv`);
    return res.send(bom + header + rows);
  }

  // --- 集計 ---
  const summary = {
    total: documents.reduce((sum, d) => sum + d.amount, 0),
    invoiceTotal: documents.filter(d => d.type === '請求書').reduce((sum, d) => sum + d.amount, 0),
    receiptTotal: documents.filter(d => d.type === '領収書').reduce((sum, d) => sum + d.amount, 0),
    count: documents.length,
    invoiceCount: documents.filter(d => d.type === '請求書').length,
    receiptCount: documents.filter(d => d.type === '領収書').length,
  };

  // 月別利用可能な月リスト（フィルターUI用）
  const months = [...new Set(documents.map(d => d.date ? d.date.substring(0, 7) : '').filter(Boolean))].sort().reverse();

  return res.json({ documents, summary, months });
};
