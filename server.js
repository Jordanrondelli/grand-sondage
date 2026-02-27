const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'clubsecret2026';
const ANSWER_THRESHOLD = 100;

// --------------- Database Setup ---------------

const dbPath = process.env.DB_PATH || path.join(__dirname, 'survey.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    FOREIGN KEY (category_id) REFERENCES categories(id)
  );
  CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (question_id) REFERENCES questions(id)
  );
  CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id);
`);

// Seed data if empty
const catCount = db.prepare('SELECT COUNT(*) as c FROM categories').get().c;
if (catCount === 0) {
  const insertCat = db.prepare('INSERT INTO categories (name) VALUES (?)');
  const insertQ = db.prepare('INSERT INTO questions (category_id, text) VALUES (?, ?)');

  const seed = db.transaction(() => {
    const c1 = insertCat.run('Années 2000').lastInsertRowid;
    const c2 = insertCat.run('Nourriture').lastInsertRowid;
    const c3 = insertCat.run('Cinéma').lastInsertRowid;

    insertQ.run(c1, "Quel est LE site internet que tout le monde utilisait dans les années 2000 ?");
    insertQ.run(c1, "Quel est LE dessin animé que vous regardiez avant d'aller à l'école dans les années 2000 ?");
    insertQ.run(c2, "Quel est L'aliment que vous mangez en cachette devant le frigo ?");
    insertQ.run(c2, "Quel est LE plat que vous commandez en livraison quand vous avez la flemme ?");
    insertQ.run(c3, "Quel est LE méchant de film que tout le monde connaît ?");
    insertQ.run(c3, "Quel est LE film que toute la famille regarde à Noël ?");
  });
  seed();
}

// --------------- Prepared Statements ---------------

const stmts = {
  getAvailableQuestion: db.prepare(`
    SELECT q.id, q.text FROM questions q
    WHERE q.active = 1
      AND (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) < ?
      AND q.id NOT IN (SELECT value FROM json_each(?))
    ORDER BY RANDOM() LIMIT 1
  `),
  insertAnswer: db.prepare('INSERT INTO answers (question_id, text) VALUES (?, ?)'),
  getAnswerCount: db.prepare('SELECT COUNT(*) as c FROM answers WHERE question_id = ?'),
  getAllCategories: db.prepare('SELECT * FROM categories ORDER BY name'),
  getQuestionsWithCounts: db.prepare(`
    SELECT q.id, q.text, q.active, q.category_id, c.name as category_name,
           (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) as answer_count
    FROM questions q
    JOIN categories c ON c.id = q.category_id
    ORDER BY c.name, q.id
  `),
  getQuestionById: db.prepare('SELECT q.*, c.name as category_name FROM questions q JOIN categories c ON c.id = q.category_id WHERE q.id = ?'),
  getAnswersGrouped: db.prepare(`
    SELECT LOWER(TRIM(text)) as normalized, text as sample_text, COUNT(*) as count
    FROM answers WHERE question_id = ?
    GROUP BY LOWER(TRIM(text))
    ORDER BY count DESC
  `),
  getTotalAnswers: db.prepare('SELECT COUNT(*) as c FROM answers'),
  getCompleteQuestions: db.prepare(`
    SELECT COUNT(*) as c FROM questions q
    WHERE (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) >= ?
  `),
  getTotalQuestions: db.prepare('SELECT COUNT(*) as c FROM questions WHERE active = 1'),
  insertQuestion: db.prepare('INSERT INTO questions (category_id, text) VALUES (?, ?)'),
  updateQuestion: db.prepare('UPDATE questions SET text = ?, category_id = ? WHERE id = ?'),
  deleteQuestion: db.prepare('DELETE FROM questions WHERE id = ?'),
  deleteAnswersForQuestion: db.prepare('DELETE FROM answers WHERE question_id = ?'),
  mergeAnswers: db.prepare('UPDATE answers SET text = ? WHERE question_id = ? AND LOWER(TRIM(text)) IN (SELECT value FROM json_each(?))'),
  deleteAllAnswers: db.prepare('DELETE FROM answers'),
  insertCategory: db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)'),
  getAllAnswersForExport: db.prepare(`
    SELECT c.name as category, q.text as question, LOWER(TRIM(a.text)) as answer, COUNT(*) as count
    FROM answers a
    JOIN questions q ON q.id = a.question_id
    JOIN categories c ON c.id = q.category_id
    GROUP BY q.id, LOWER(TRIM(a.text))
    ORDER BY c.name, q.id, count DESC
  `),
};

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

app.get('/api/questions/next', (req, res) => {
  const excludeRaw = req.query.exclude || '[]';
  let excludeList;
  try {
    excludeList = JSON.parse(excludeRaw);
    if (!Array.isArray(excludeList)) excludeList = [];
  } catch {
    excludeList = [];
  }

  const question = stmts.getAvailableQuestion.get(ANSWER_THRESHOLD, JSON.stringify(excludeList));
  if (!question) {
    return res.json({ done: true });
  }
  res.json({ id: question.id, text: question.text });
});

app.post('/api/answers', rateLimit, (req, res) => {
  const { question_id, text } = req.body;
  if (!question_id || !text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Réponse invalide' });
  }

  const cleaned = text.trim();
  if (cleaned.length === 0 || cleaned.length > 200) {
    return res.status(400).json({ error: 'Réponse trop courte ou trop longue' });
  }

  // Check question hasn't reached threshold
  const count = stmts.getAnswerCount.get(question_id).c;
  if (count >= ANSWER_THRESHOLD) {
    return res.status(410).json({ error: 'Cette question a déjà assez de réponses' });
  }

  stmts.insertAnswer.run(question_id, cleaned);
  res.json({ ok: true });
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

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const totalAnswers = stmts.getTotalAnswers.get().c;
  const completeQuestions = stmts.getCompleteQuestions.get(ANSWER_THRESHOLD).c;
  const totalQuestions = stmts.getTotalQuestions.get().c;
  res.json({ totalAnswers, completeQuestions, totalQuestions, threshold: ANSWER_THRESHOLD });
});

app.get('/api/admin/categories', requireAdmin, (req, res) => {
  res.json(stmts.getAllCategories.all());
});

app.post('/api/admin/categories', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  const result = stmts.insertCategory.run(name.trim());
  res.json({ id: result.lastInsertRowid, name: name.trim() });
});

app.get('/api/admin/questions', requireAdmin, (req, res) => {
  res.json(stmts.getQuestionsWithCounts.all());
});

app.post('/api/admin/questions', requireAdmin, (req, res) => {
  const { category_id, text } = req.body;
  if (!category_id || !text || !text.trim()) {
    return res.status(400).json({ error: 'Catégorie et texte requis' });
  }
  const result = stmts.insertQuestion.run(category_id, text.trim());
  res.json({ id: result.lastInsertRowid });
});

app.put('/api/admin/questions/:id', requireAdmin, (req, res) => {
  const { text, category_id } = req.body;
  if (!text || !text.trim() || !category_id) {
    return res.status(400).json({ error: 'Texte et catégorie requis' });
  }
  stmts.updateQuestion.run(text.trim(), category_id, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/questions/:id', requireAdmin, (req, res) => {
  const deleteTransaction = db.transaction((id) => {
    stmts.deleteAnswersForQuestion.run(id);
    stmts.deleteQuestion.run(id);
  });
  deleteTransaction(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/questions/:id/answers', requireAdmin, (req, res) => {
  const question = stmts.getQuestionById.get(req.params.id);
  if (!question) return res.status(404).json({ error: 'Question introuvable' });

  const answers = stmts.getAnswersGrouped.all(req.params.id);
  const totalCount = answers.reduce((sum, a) => sum + a.count, 0);

  // Calculate top 5 coverage
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
});

app.post('/api/admin/merge', requireAdmin, (req, res) => {
  const { question_id, answer_texts, canonical_text } = req.body;
  if (!question_id || !answer_texts || !Array.isArray(answer_texts) || !canonical_text) {
    return res.status(400).json({ error: 'Données invalides' });
  }
  const lowered = answer_texts.map(t => t.toLowerCase().trim());
  stmts.mergeAnswers.run(canonical_text.trim(), question_id, JSON.stringify(lowered));
  res.json({ ok: true });
});

app.get('/api/admin/export', requireAdmin, (req, res) => {
  const rows = stmts.getAllAnswersForExport.all();
  const totalByQuestion = {};
  rows.forEach(r => {
    const key = r.question;
    totalByQuestion[key] = (totalByQuestion[key] || 0) + r.count;
  });

  let csv = '\uFEFF"Catégorie";"Question";"Réponse";"Nombre";"Pourcentage"\n';
  rows.forEach(r => {
    const total = totalByQuestion[r.question];
    const pct = total > 0 ? Math.round((r.count / total) * 100) : 0;
    const escape = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    csv += `${escape(r.category)};${escape(r.question)};${escape(r.answer)};${r.count};${pct}%\n`;
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sondage-export.csv"');
  res.send(csv);
});

app.post('/api/admin/reset', requireAdmin, (req, res) => {
  stmts.deleteAllAnswers.run();
  res.json({ ok: true });
});

// --------------- Fallback ---------------

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --------------- Start ---------------

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
});
