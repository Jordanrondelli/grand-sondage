const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'clubsecret2026';

// --------------- Rate Limiter ---------------

const rateLimitMap = new Map();
const RATE_LIMIT_MS = 800;

setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of rateLimitMap) {
    if (now - ts > 60000) rateLimitMap.delete(ip);
  }
}, 60000);

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const last = rateLimitMap.get(ip);
  if (last && Date.now() - last < RATE_LIMIT_MS) {
    return res.status(429).json({ error: 'Trop rapide, attends un peu.' });
  }
  rateLimitMap.set(ip, Date.now());
  next();
}

// --------------- Middleware ---------------

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: 'Non autorisé' });
}

// --------------- Public API ---------------

app.get('/api/questions/next', async (req, res) => {
  try {
    const excludeRaw = req.query.exclude || '[]';
    let excludeList;
    try {
      excludeList = JSON.parse(excludeRaw);
      if (!Array.isArray(excludeList)) excludeList = [];
    } catch {
      excludeList = [];
    }

    const question = await db.getAvailableQuestion(excludeList);
    if (!question) return res.json({ done: true });
    res.json({ id: question.id, text: question.text });
  } catch (err) {
    console.error('GET /api/questions/next error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/answers', rateLimit, async (req, res) => {
  try {
    const { question_id, text } = req.body;
    if (!question_id || !text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Réponse invalide' });
    }

    const cleaned = text.trim();
    if (cleaned.length === 0 || cleaned.length > 200) {
      return res.status(400).json({ error: 'Réponse trop courte ou trop longue' });
    }

    const count = await db.getAnswerCount(question_id);
    if (count >= db.THRESHOLD) {
      return res.status(410).json({ error: 'Cette question a déjà assez de réponses' });
    }

    await db.insertAnswer(question_id, cleaned);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/answers error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// --------------- Admin Auth ---------------

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Mot de passe incorrect' });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.isAdmin) });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// --------------- Admin API ---------------

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    res.json(await db.getStats());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/categories', requireAdmin, async (req, res) => {
  try {
    res.json(await db.getAllCategories());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/categories', requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
    const cat = await db.insertCategory(name.trim());
    res.json(cat);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/questions', requireAdmin, async (req, res) => {
  try {
    res.json(await db.getQuestionsWithCounts());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/questions', requireAdmin, async (req, res) => {
  try {
    const { category_id, text } = req.body;
    if (!category_id || !text || !text.trim()) {
      return res.status(400).json({ error: 'Catégorie et texte requis' });
    }
    const result = await db.insertQuestion(category_id, text.trim());
    res.json({ id: result.lastInsertRowid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.put('/api/admin/questions/:id', requireAdmin, async (req, res) => {
  try {
    const { text, category_id } = req.body;
    if (!text || !text.trim() || !category_id) {
      return res.status(400).json({ error: 'Texte et catégorie requis' });
    }
    await db.updateQuestion(req.params.id, text.trim(), category_id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/admin/questions/:id', requireAdmin, async (req, res) => {
  try {
    await db.deleteQuestion(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/questions/:id/answers', requireAdmin, async (req, res) => {
  try {
    const question = await db.getQuestionById(req.params.id);
    if (!question) return res.status(404).json({ error: 'Question introuvable' });

    const answers = await db.getAnswersGrouped(req.params.id);
    const totalCount = answers.reduce((sum, a) => sum + a.count, 0);

    const top5 = answers.slice(0, 5);
    const top5Count = top5.reduce((sum, a) => sum + a.count, 0);
    const top5Pct = totalCount > 0 ? Math.round((top5Count / totalCount) * 100) : 0;

    let top5Status = 'neutral';
    if (totalCount >= 20) {
      if (top5Pct >= 60 && top5Pct <= 85) top5Status = 'good';
      else if (top5Pct > 85) top5Status = 'concentrated';
      else if (top5Pct < 60) top5Status = 'scattered';
    }

    res.json({
      question,
      answers: answers.map(a => ({
        ...a,
        percentage: totalCount > 0 ? Math.round((a.count / totalCount) * 100) : 0
      })),
      totalCount,
      top5Pct,
      top5Status
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/merge', requireAdmin, async (req, res) => {
  try {
    const { question_id, answer_texts, canonical_text } = req.body;
    if (!question_id || !answer_texts || !Array.isArray(answer_texts) || !canonical_text) {
      return res.status(400).json({ error: 'Données invalides' });
    }
    await db.mergeAnswers(question_id, answer_texts, canonical_text.trim());
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/export', requireAdmin, async (req, res) => {
  try {
    const rows = await db.getAllAnswersForExport();
    const totalByQuestion = {};
    rows.forEach(r => {
      totalByQuestion[r.question] = (totalByQuestion[r.question] || 0) + r.count;
    });

    let csv = '\uFEFF"Catégorie";"Question";"Réponse";"Nombre";"Pourcentage"\n';
    rows.forEach(r => {
      const total = totalByQuestion[r.question];
      const pct = total > 0 ? Math.round((r.count / total) * 100) : 0;
      const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"';
      csv += `${esc(r.category)};${esc(r.question)};${esc(r.answer)};${r.count};${pct}%\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sondage-export.csv"');
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/reset', requireAdmin, async (req, res) => {
  try {
    await db.deleteAllAnswers();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// --------------- Fallback ---------------

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --------------- Start ---------------

db.init().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
