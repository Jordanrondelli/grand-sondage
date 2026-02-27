const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'clubsecret2026';

// --- Normalization ---

function normalizeAnswer(text) {
  return text
    .toLowerCase()
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f]/gu, '')
    .replace(/[^a-zà-ÿ0-9\s''\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Rate limiter ---

const rateLimitMap = new Map();
setInterval(() => { const now = Date.now(); for (const [ip, ts] of rateLimitMap) { if (now - ts > 60000) rateLimitMap.delete(ip); } }, 60000);
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const last = rateLimitMap.get(ip);
  if (last && Date.now() - last < 800) return res.status(429).json({ error: 'Trop rapide' });
  rateLimitMap.set(ip, Date.now());
  next();
}

// --- Middleware ---

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false, saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 86400000 }
}));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: false }));

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  res.status(401).json({ error: 'Non autorisé' });
}

// --- Public API ---

app.get('/api/questions/next', async (req, res) => {
  try {
    let ex; try { ex = JSON.parse(req.query.exclude || '[]'); if (!Array.isArray(ex)) ex = []; } catch { ex = []; }
    const q = await db.getAvailableQuestion(ex);
    if (!q) return res.json({ done: true });
    res.json({ id: q.id, text: q.text });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/answers', rateLimit, async (req, res) => {
  try {
    const { question_id, text } = req.body;
    if (!question_id || !text || typeof text !== 'string')
      return res.status(400).json({ error: 'Invalide' });

    const normalized = normalizeAnswer(text);
    if (!normalized || normalized.length > 120)
      return res.status(400).json({ error: 'Invalide' });

    const count = await db.getAnswerCount(question_id);
    if (count >= db.THRESHOLD)
      return res.status(410).json({ error: 'Complet' });

    await db.insertAnswer(question_id, normalized);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

// --- Admin Auth ---

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) { req.session.isAdmin = true; return res.json({ ok: true }); }
  res.status(401).json({ error: 'Mot de passe incorrect' });
});
app.get('/api/admin/check', (req, res) => { res.json({ authenticated: !!req.session?.isAdmin }); });
app.post('/api/admin/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

// --- Admin API ---

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try { res.json(await db.getStats()); } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.get('/api/admin/categories', requireAdmin, async (req, res) => {
  try { res.json(await db.getAllCategories()); } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/admin/categories', requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' });
    res.json(await db.insertCategory(name.trim()));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.get('/api/admin/questions', requireAdmin, async (req, res) => {
  try { res.json(await db.getQuestionsWithCounts()); } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/admin/questions', requireAdmin, async (req, res) => {
  try {
    const { category_id, text } = req.body;
    if (!category_id || !text?.trim()) return res.status(400).json({ error: 'Requis' });
    const r = await db.insertQuestion(category_id, text.trim());
    res.json({ id: r.lastInsertRowid });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.put('/api/admin/questions/:id', requireAdmin, async (req, res) => {
  try {
    const { text, category_id } = req.body;
    if (!text?.trim() || !category_id) return res.status(400).json({ error: 'Requis' });
    await db.updateQuestion(req.params.id, text.trim(), category_id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.delete('/api/admin/questions/:id', requireAdmin, async (req, res) => {
  try { await db.deleteQuestion(req.params.id); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.get('/api/admin/questions/:id/answers', requireAdmin, async (req, res) => {
  try {
    const question = await db.getQuestionById(req.params.id);
    if (!question) return res.status(404).json({ error: 'Introuvable' });
    const answers = await db.getAnswersGrouped(req.params.id);
    const totalCount = answers.reduce((s, a) => s + a.count, 0);
    const top5 = answers.slice(0, 5);
    const top5Count = top5.reduce((s, a) => s + a.count, 0);
    const top5Pct = totalCount > 0 ? (top5Count / totalCount) * 100 : 0;
    let top5Status = 'neutral';
    if (totalCount >= 20) {
      if (top5Pct >= 60 && top5Pct <= 85) top5Status = 'good';
      else if (top5Pct > 85) top5Status = 'concentrated';
      else if (top5Pct < 60) top5Status = 'scattered';
    }
    res.json({
      question, answers: answers.map(a => ({
        ...a, percentage: totalCount > 0 ? (a.count / totalCount) * 100 : 0
      })),
      totalCount, top5Pct, top5Status
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/admin/merge', requireAdmin, async (req, res) => {
  try {
    const { question_id, answer_texts, canonical_text } = req.body;
    if (!question_id || !answer_texts?.length || !canonical_text)
      return res.status(400).json({ error: 'Invalide' });
    await db.mergeAnswers(question_id, answer_texts, canonical_text.trim());
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.get('/api/admin/export', requireAdmin, async (req, res) => {
  try {
    const rows = await db.getAllAnswersForExport();
    const totals = {};
    rows.forEach(r => { totals[r.question_id] = (totals[r.question_id] || 0) + r.count; });
    let csv = '\uFEFFquestion_id,club,question,réponse,count,pourcentage\n';
    rows.forEach(r => {
      const t = totals[r.question_id];
      const p = t > 0 ? ((r.count / t) * 100).toFixed(1) : '0.0';
      const e = s => '"' + String(s).replace(/"/g, '""') + '"';
      csv += `${r.question_id},${e(r.club)},${e(r.question)},${e(r.answer)},${r.count},${p}%\n`;
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clubs_secrets_resultats.csv"');
    res.send(csv);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/admin/reset', requireAdmin, async (req, res) => {
  try { await db.deleteAllAnswers(); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });

db.init().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server: http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin`);
  });
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
