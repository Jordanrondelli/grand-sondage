#!/bin/bash
set -e

# ============================================
#  LE GRAND SONDAGE - Script de deploiement
#  Copie-colle ce script dans ton Terminal Mac
# ============================================

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

echo ""
echo -e "${BOLD}==========================================${NC}"
echo -e "${BOLD}  LE GRAND SONDAGE - Installation${NC}"
echo -e "${BOLD}==========================================${NC}"
echo ""

# --- 1. Check git ---
if ! command -v git &>/dev/null; then
  echo -e "${YELLOW}Git n'est pas installe. Installation...${NC}"
  xcode-select --install 2>/dev/null
  echo -e "${RED}Une fenetre va s'ouvrir. Clique sur 'Installer'.${NC}"
  echo -e "${RED}Une fois fini, relance ce script.${NC}"
  exit 1
fi

# --- 2. Check Node.js ---
if ! command -v node &>/dev/null; then
  echo -e "${YELLOW}Node.js n'est pas installe. Installation via nvm...${NC}"
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm install 20
  echo -e "${GREEN}Node.js installe !${NC}"
fi

NODE_V=$(node -v)
echo -e "${GREEN}Node.js $NODE_V detecte${NC}"

# --- 3. Check/Install GitHub CLI ---
if ! command -v gh &>/dev/null; then
  echo -e "${YELLOW}Installation de GitHub CLI...${NC}"
  if command -v brew &>/dev/null; then
    brew install gh
  else
    echo -e "${YELLOW}Homebrew non detecte. Installation de Homebrew...${NC}"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Add brew to path (Apple Silicon or Intel)
    if [ -f /opt/homebrew/bin/brew ]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [ -f /usr/local/bin/brew ]; then
      eval "$(/usr/local/bin/brew shellenv)"
    fi
    brew install gh
  fi
fi
echo -e "${GREEN}GitHub CLI detecte${NC}"

# --- 4. GitHub login ---
if ! gh auth status &>/dev/null 2>&1; then
  echo ""
  echo -e "${BOLD}Connexion a GitHub...${NC}"
  echo -e "Une page va s'ouvrir dans ton navigateur. Connecte-toi a GitHub."
  echo ""
  gh auth login -w -p https
fi
echo -e "${GREEN}Connecte a GitHub !${NC}"

# --- 5. Create project ---
PROJECT_DIR="$HOME/grand-sondage"
if [ -d "$PROJECT_DIR" ]; then
  echo -e "${YELLOW}Le dossier ~/grand-sondage existe deja. Suppression...${NC}"
  rm -rf "$PROJECT_DIR"
fi

echo ""
echo -e "${BOLD}Creation du projet...${NC}"
mkdir -p "$PROJECT_DIR/public/css" "$PROJECT_DIR/public/js"
cd "$PROJECT_DIR"

# --- package.json ---
cat > package.json << 'ENDOFFILE'
{
  "name": "grand-sondage",
  "version": "1.0.0",
  "description": "Survey app - Une Famille en Or style",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "better-sqlite3": "^11.7.0",
    "express": "^4.21.0",
    "express-session": "^1.18.1",
    "pg": "^8.13.0"
  },
  "engines": {
    "node": ">=18"
  }
}
ENDOFFILE

# --- render.yaml ---
cat > render.yaml << 'ENDOFFILE'
databases:
  - name: survey-db
    plan: free
    databaseName: survey
    user: survey

services:
  - type: web
    name: grand-sondage
    runtime: node
    plan: free
    buildCommand: npm install
    startCommand: node server.js
    envVars:
      - key: NODE_ENV
        value: production
      - key: ADMIN_PASSWORD
        value: clubsecret2026
      - key: DATABASE_URL
        fromDatabase:
          name: survey-db
          property: connectionString
ENDOFFILE

# --- .gitignore ---
cat > .gitignore << 'ENDOFFILE'
node_modules/
survey.db
survey.db-shm
survey.db-wal
.env
ENDOFFILE

# --- db.js ---
cat > db.js << 'DBEOF'
const path = require('path');

const isPostgres = !!process.env.DATABASE_URL;
let pool, sqlite;

if (isPostgres) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
} else {
  const Database = require('better-sqlite3');
  sqlite = new Database(process.env.DB_PATH || path.join(__dirname, 'survey.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
}

async function exec(sql) {
  if (isPostgres) { await pool.query(sql); }
  else { sqlite.exec(sql); }
}

async function all(sql, params = []) {
  if (isPostgres) {
    const res = await pool.query(sql, params);
    return res.rows;
  } else {
    const sqliteSql = sql.replace(/\$\d+/g, '?');
    return sqlite.prepare(sqliteSql).all(...params);
  }
}

async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0] || null;
}

async function run(sql, params = []) {
  if (isPostgres) {
    const res = await pool.query(sql + ' RETURNING *', params);
    return { lastInsertRowid: res.rows[0]?.id, changes: res.rowCount };
  } else {
    const sqliteSql = sql.replace(/\$\d+/g, '?');
    const info = sqlite.prepare(sqliteSql).run(...params);
    return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
  }
}

async function runNoReturn(sql, params = []) {
  if (isPostgres) { await pool.query(sql, params); }
  else { sqlite.prepare(sql.replace(/\$\d+/g, '?')).run(...params); }
}

async function init() {
  if (isPostgres) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS categories (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS questions (id SERIAL PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id), text TEXT NOT NULL, active INTEGER DEFAULT 1);
      CREATE TABLE IF NOT EXISTS answers (id SERIAL PRIMARY KEY, question_id INTEGER NOT NULL REFERENCES questions(id), text TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id);
    `);
  } else {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL, text TEXT NOT NULL, active INTEGER DEFAULT 1, FOREIGN KEY (category_id) REFERENCES categories(id));
      CREATE TABLE IF NOT EXISTS answers (id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INTEGER NOT NULL, text TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (question_id) REFERENCES questions(id));
      CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id);
    `);
  }
  const row = await get('SELECT COUNT(*) as c FROM categories');
  if (row.c === 0) {
    const c1 = (await run("INSERT INTO categories (name) VALUES ($1)", ['Années 2000'])).lastInsertRowid;
    const c2 = (await run("INSERT INTO categories (name) VALUES ($1)", ['Nourriture'])).lastInsertRowid;
    const c3 = (await run("INSERT INTO categories (name) VALUES ($1)", ['Cinéma'])).lastInsertRowid;
    const questions = [
      [c1, "Quel est LE site internet que tout le monde utilisait dans les années 2000 ?"],
      [c1, "Quel est LE dessin animé que vous regardiez avant d'aller à l'école dans les années 2000 ?"],
      [c2, "Quel est L'aliment que vous mangez en cachette devant le frigo ?"],
      [c2, "Quel est LE plat que vous commandez en livraison quand vous avez la flemme ?"],
      [c3, "Quel est LE méchant de film que tout le monde connaît ?"],
      [c3, "Quel est LE film que toute la famille regarde à Noël ?"],
    ];
    for (const [catId, text] of questions) { await run("INSERT INTO questions (category_id, text) VALUES ($1, $2)", [catId, text]); }
  }
}

const THRESHOLD = 100;

async function getAvailableQuestion(excludeIds) {
  if (isPostgres) {
    const rows = await all("SELECT q.id, q.text FROM questions q WHERE q.active = 1 AND (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) < $1 AND NOT (q.id = ANY($2::int[])) ORDER BY RANDOM() LIMIT 1", [THRESHOLD, excludeIds]);
    return rows[0] || null;
  } else {
    return sqlite.prepare("SELECT q.id, q.text FROM questions q WHERE q.active = 1 AND (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) < ? AND q.id NOT IN (SELECT value FROM json_each(?)) ORDER BY RANDOM() LIMIT 1").get(THRESHOLD, JSON.stringify(excludeIds)) || null;
  }
}

async function insertAnswer(qid, text) { await runNoReturn("INSERT INTO answers (question_id, text) VALUES ($1, $2)", [qid, text]); }
async function getAnswerCount(qid) { return (await get("SELECT COUNT(*) as c FROM answers WHERE question_id = $1", [qid])).c; }
async function getAllCategories() { return all("SELECT * FROM categories ORDER BY name"); }
async function getQuestionsWithCounts() { return all("SELECT q.id, q.text, q.active, q.category_id, c.name as category_name, (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) as answer_count FROM questions q JOIN categories c ON c.id = q.category_id ORDER BY c.name, q.id"); }
async function getQuestionById(id) { return get("SELECT q.*, c.name as category_name FROM questions q JOIN categories c ON c.id = q.category_id WHERE q.id = $1", [id]); }
async function getAnswersGrouped(qid) { return all("SELECT LOWER(TRIM(text)) as normalized, MIN(text) as sample_text, COUNT(*) as count FROM answers WHERE question_id = $1 GROUP BY LOWER(TRIM(text)) ORDER BY count DESC", [qid]); }
async function getStats() {
  const totalAnswers = (await get("SELECT COUNT(*) as c FROM answers")).c;
  const completeQuestions = (await get("SELECT COUNT(*) as c FROM questions q WHERE (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) >= $1", [THRESHOLD])).c;
  const totalQuestions = (await get("SELECT COUNT(*) as c FROM questions WHERE active = 1")).c;
  return { totalAnswers, completeQuestions, totalQuestions, threshold: THRESHOLD };
}
async function insertQuestion(catId, text) { return run("INSERT INTO questions (category_id, text) VALUES ($1, $2)", [catId, text]); }
async function updateQuestion(id, text, catId) { await runNoReturn("UPDATE questions SET text = $1, category_id = $2 WHERE id = $3", [text, catId, id]); }
async function deleteQuestion(id) { await runNoReturn("DELETE FROM answers WHERE question_id = $1", [id]); await runNoReturn("DELETE FROM questions WHERE id = $1", [id]); }
async function mergeAnswers(qid, texts, canonical) {
  const lowered = texts.map(t => t.toLowerCase().trim());
  if (isPostgres) { await pool.query("UPDATE answers SET text = $1 WHERE question_id = $2 AND LOWER(TRIM(text)) = ANY($3::text[])", [canonical, qid, lowered]); }
  else { sqlite.prepare("UPDATE answers SET text = ? WHERE question_id = ? AND LOWER(TRIM(text)) IN (SELECT value FROM json_each(?))").run(canonical, qid, JSON.stringify(lowered)); }
}
async function getAllAnswersForExport() { return all("SELECT c.name as category, q.text as question, LOWER(TRIM(a.text)) as answer, COUNT(*) as count FROM answers a JOIN questions q ON q.id = a.question_id JOIN categories c ON c.id = q.category_id GROUP BY c.name, q.text, LOWER(TRIM(a.text)) ORDER BY c.name, q.text, count DESC"); }
async function deleteAllAnswers() { await runNoReturn("DELETE FROM answers"); }
async function insertCategory(name) {
  if (isPostgres) { const res = await pool.query("INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *", [name]); return res.rows[0] || (await get("SELECT * FROM categories WHERE name = $1", [name])); }
  else { sqlite.prepare("INSERT OR IGNORE INTO categories (name) VALUES (?)").run(name); return sqlite.prepare("SELECT * FROM categories WHERE name = ?").get(name); }
}

module.exports = { init, getAvailableQuestion, insertAnswer, getAnswerCount, getAllCategories, getQuestionsWithCounts, getQuestionById, getAnswersGrouped, getStats, insertQuestion, updateQuestion, deleteQuestion, mergeAnswers, getAllAnswersForExport, deleteAllAnswers, insertCategory, THRESHOLD };
DBEOF

# --- server.js ---
cat > server.js << 'SRVEOF'
const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'clubsecret2026';

const rateLimitMap = new Map();
setInterval(() => { const now = Date.now(); for (const [ip, ts] of rateLimitMap) { if (now - ts > 60000) rateLimitMap.delete(ip); } }, 60000);
function rateLimit(req, res, next) { const ip = req.ip || req.connection.remoteAddress; const last = rateLimitMap.get(ip); if (last && Date.now() - last < 800) return res.status(429).json({ error: 'Trop rapide' }); rateLimitMap.set(ip, Date.now()); next(); }

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({ secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'), resave: false, saveUninitialized: false, cookie: { secure: false, httpOnly: true, maxAge: 86400000 } }));
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) { if (req.session?.isAdmin) return next(); res.status(401).json({ error: 'Non autorise' }); }

app.get('/api/questions/next', async (req, res) => { try { let ex; try { ex = JSON.parse(req.query.exclude || '[]'); if (!Array.isArray(ex)) ex = []; } catch { ex = []; } const q = await db.getAvailableQuestion(ex); if (!q) return res.json({ done: true }); res.json({ id: q.id, text: q.text }); } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); } });
app.post('/api/answers', rateLimit, async (req, res) => { try { const { question_id, text } = req.body; if (!question_id || !text || typeof text !== 'string') return res.status(400).json({ error: 'Invalide' }); const cleaned = text.trim(); if (!cleaned || cleaned.length > 200) return res.status(400).json({ error: 'Invalide' }); const count = await db.getAnswerCount(question_id); if (count >= db.THRESHOLD) return res.status(410).json({ error: 'Complet' }); await db.insertAnswer(question_id, cleaned); res.json({ ok: true }); } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); } });

app.post('/api/admin/login', (req, res) => { if (req.body.password === ADMIN_PASSWORD) { req.session.isAdmin = true; return res.json({ ok: true }); } res.status(401).json({ error: 'Mot de passe incorrect' }); });
app.get('/api/admin/check', (req, res) => { res.json({ authenticated: !!req.session?.isAdmin }); });
app.post('/api/admin/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/api/admin/stats', requireAdmin, async (req, res) => { try { res.json(await db.getStats()); } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); } });
app.get('/api/admin/categories', requireAdmin, async (req, res) => { try { res.json(await db.getAllCategories()); } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); } });
app.post('/api/admin/categories', requireAdmin, async (req, res) => { try { const { name } = req.body; if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' }); res.json(await db.insertCategory(name.trim())); } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); } });
app.get('/api/admin/questions', requireAdmin, async (req, res) => { try { res.json(await db.getQuestionsWithCounts()); } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); } });
app.post('/api/admin/questions', requireAdmin, async (req, res) => { try { const { category_id, text } = req.body; if (!category_id || !text?.trim()) return res.status(400).json({ error: 'Requis' }); const r = await db.insertQuestion(category_id, text.trim()); res.json({ id: r.lastInsertRowid }); } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); } });
app.put('/api/admin/questions/:id', requireAdmin, async (req, res) => { try { const { text, category_id } = req.body; if (!text?.trim() || !category_id) return res.status(400).json({ error: 'Requis' }); await db.updateQuestion(req.params.id, text.trim(), category_id); res.json({ ok: true }); } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); } });
app.delete('/api/admin/questions/:id', requireAdmin, async (req, res) => { try { await db.deleteQuestion(req.params.id); res.json({ ok: true }); } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); } });

app.get('/api/admin/questions/:id/answers', requireAdmin, async (req, res) => {
  try {
    const question = await db.getQuestionById(req.params.id);
    if (!question) return res.status(404).json({ error: 'Introuvable' });
    const answers = await db.getAnswersGrouped(req.params.id);
    const totalCount = answers.reduce((s, a) => s + a.count, 0);
    const top5 = answers.slice(0, 5);
    const top5Count = top5.reduce((s, a) => s + a.count, 0);
    const top5Pct = totalCount > 0 ? Math.round((top5Count / totalCount) * 100) : 0;
    let top5Status = 'neutral';
    if (totalCount >= 20) { if (top5Pct >= 60 && top5Pct <= 85) top5Status = 'good'; else if (top5Pct > 85) top5Status = 'concentrated'; else if (top5Pct < 60) top5Status = 'scattered'; }
    res.json({ question, answers: answers.map(a => ({ ...a, percentage: totalCount > 0 ? Math.round((a.count / totalCount) * 100) : 0 })), totalCount, top5Pct, top5Status });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/admin/merge', requireAdmin, async (req, res) => { try { const { question_id, answer_texts, canonical_text } = req.body; if (!question_id || !answer_texts?.length || !canonical_text) return res.status(400).json({ error: 'Invalide' }); await db.mergeAnswers(question_id, answer_texts, canonical_text.trim()); res.json({ ok: true }); } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); } });

app.get('/api/admin/export', requireAdmin, async (req, res) => {
  try {
    const rows = await db.getAllAnswersForExport();
    const totals = {};
    rows.forEach(r => { totals[r.question] = (totals[r.question] || 0) + r.count; });
    let csv = '\uFEFF"Categorie";"Question";"Reponse";"Nombre";"Pourcentage"\n';
    rows.forEach(r => { const t = totals[r.question]; const p = t > 0 ? Math.round((r.count / t) * 100) : 0; const e = s => '"' + String(s).replace(/"/g, '""') + '"'; csv += `${e(r.category)};${e(r.question)};${e(r.answer)};${r.count};${p}%\n`; });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sondage-export.csv"');
    res.send(csv);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/admin/reset', requireAdmin, async (req, res) => { try { await db.deleteAllAnswers(); res.json({ ok: true }); } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); } });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
db.init().then(() => { app.listen(PORT, '0.0.0.0', () => { console.log(`Server: http://localhost:${PORT}`); console.log(`Admin: http://localhost:${PORT}/admin`); }); }).catch(e => { console.error('DB init failed:', e); process.exit(1); });
SRVEOF

# --- public/index.html ---
cat > public/index.html << 'HTMLEOF'
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Le Grand Sondage</title>
  <link rel="stylesheet" href="/css/style.css">
</head>
<body>
  <div id="app">
    <div id="screen-welcome" class="screen active">
      <div class="card welcome-card">
        <h1 class="title">Le Grand<br><span class="accent">Sondage</span></h1>
        <p class="subtitle">Aide-nous a construire le jeu !</p>
        <div class="rules">
          <div class="rule"><span class="rule-icon">1</span><span>Une seule reponse par question</span></div>
          <div class="rule"><span class="rule-icon">2</span><span>Sois spontane, pas de triche</span></div>
          <div class="rule"><span class="rule-icon">3</span><span>30 secondes par question</span></div>
        </div>
        <button id="btn-start" class="btn btn-primary btn-large">Commencer</button>
      </div>
    </div>
    <div id="screen-question" class="screen">
      <div class="card question-card">
        <div class="timer-container"><div id="timer-bar" class="timer-bar"></div></div>
        <div id="timer-text" class="timer-text">30s</div>
        <div id="question-counter" class="question-counter"></div>
        <h2 id="question-text" class="question-text"></h2>
        <form id="answer-form">
          <input type="text" id="answer-input" class="input" placeholder="Ta reponse..." autocomplete="off" maxlength="200">
          <button type="submit" id="btn-submit" class="btn btn-primary">Valider</button>
        </form>
      </div>
    </div>
    <div id="screen-transition" class="screen">
      <div class="card transition-card"><div class="checkmark">&#10003;</div><p>Reponse enregistree !</p></div>
    </div>
    <div id="screen-done" class="screen">
      <div class="card done-card"><div class="done-icon">&#127881;</div><h2>Merci !</h2><p>Tu as repondu a toutes les questions disponibles.</p><p class="done-sub">Les resultats serviront a construire le jeu.</p></div>
    </div>
  </div>
  <script src="/js/survey.js"></script>
</body>
</html>
HTMLEOF

# --- public/admin.html ---
cat > public/admin.html << 'ADMEOF'
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin - Le Grand Sondage</title>
  <link rel="stylesheet" href="/css/style.css">
</head>
<body class="admin-body">
  <div id="view-login" class="screen active">
    <div class="card login-card">
      <h1>Admin</h1>
      <form id="login-form">
        <input type="password" id="login-password" class="input" placeholder="Mot de passe" autocomplete="current-password">
        <button type="submit" class="btn btn-primary">Connexion</button>
      </form>
      <p id="login-error" class="error-text" style="display:none"></p>
    </div>
  </div>
  <div id="view-dashboard" class="screen">
    <div class="admin-container">
      <header class="admin-header">
        <h1>Dashboard</h1>
        <div class="admin-actions">
          <a href="/" class="btn btn-ghost btn-sm">Voir le sondage</a>
          <button id="btn-export" class="btn btn-ghost btn-sm">Export CSV</button>
          <button id="btn-reset" class="btn btn-danger btn-sm">Reset</button>
          <button id="btn-logout" class="btn btn-ghost btn-sm">Deconnexion</button>
        </div>
      </header>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-value" id="stat-total">0</div><div class="stat-label">Reponses totales</div></div>
        <div class="stat-card"><div class="stat-value" id="stat-complete">0/0</div><div class="stat-label">Questions completes</div></div>
        <div class="stat-card"><div class="stat-value" id="stat-progress">0%</div><div class="stat-label">Progression globale</div></div>
      </div>
      <div class="progress-wrapper"><div id="progress-bar" class="progress-bar" style="width:0%"></div></div>
      <div class="section">
        <div class="section-header"><h2>Questions par categorie</h2><button id="btn-add-question" class="btn btn-primary btn-sm">+ Ajouter</button></div>
        <div id="questions-list"></div>
      </div>
      <div id="question-form-wrapper" class="section" style="display:none">
        <h3 id="form-title">Ajouter une question</h3>
        <form id="question-form">
          <input type="hidden" id="form-question-id">
          <select id="form-category" class="input"><option value="">-- Categorie --</option></select>
          <textarea id="form-text" class="input textarea" placeholder="Texte de la question" rows="3"></textarea>
          <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">Enregistrer</button><button type="button" id="form-cancel" class="btn btn-ghost btn-sm">Annuler</button></div>
        </form>
      </div>
    </div>
  </div>
  <div id="view-detail" class="screen">
    <div class="admin-container">
      <button id="btn-back" class="btn btn-ghost btn-sm">&larr; Retour</button>
      <h2 id="detail-question-text" class="detail-title"></h2>
      <div class="detail-meta"><span id="detail-count"></span><span id="detail-category" class="badge"></span></div>
      <div id="top5-indicator" class="top5-indicator"></div>
      <div class="table-wrapper">
        <table class="answers-table">
          <thead><tr><th><input type="checkbox" id="select-all"></th><th>#</th><th>Reponse</th><th>Nombre</th><th>%</th></tr></thead>
          <tbody id="answers-tbody"></tbody>
        </table>
      </div>
      <div id="merge-tool" class="merge-tool" style="display:none">
        <h3>Fusionner les reponses selectionnees</h3>
        <input type="text" id="merge-canonical" class="input" placeholder="Texte canonique (ex: mcdo)">
        <button id="btn-merge" class="btn btn-primary btn-sm">Fusionner</button>
      </div>
    </div>
  </div>
  <script src="/js/admin.js"></script>
</body>
</html>
ADMEOF

# --- public/js/survey.js ---
cat > public/js/survey.js << 'JSEOF'
(function () {
  const TIMER_DURATION = 30;
  const STORAGE_KEY = 'survey_answered';
  let answeredIds = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  let currentQuestion = null;
  let timerInterval = null;
  let timeLeft = TIMER_DURATION;
  let questionCount = 0;
  const screens = { welcome: document.getElementById('screen-welcome'), question: document.getElementById('screen-question'), transition: document.getElementById('screen-transition'), done: document.getElementById('screen-done') };
  const questionText = document.getElementById('question-text');
  const questionCounter = document.getElementById('question-counter');
  const answerInput = document.getElementById('answer-input');
  const answerForm = document.getElementById('answer-form');
  const btnStart = document.getElementById('btn-start');
  const btnSubmit = document.getElementById('btn-submit');
  const timerBar = document.getElementById('timer-bar');
  const timerTextEl = document.getElementById('timer-text');

  function showScreen(name) { Object.values(screens).forEach(s => s.classList.remove('active')); screens[name].classList.add('active'); }
  async function fetchNextQuestion() { const res = await fetch('/api/questions/next?exclude=' + encodeURIComponent(JSON.stringify(answeredIds))); return res.json(); }
  function startTimer() {
    timeLeft = TIMER_DURATION; timerBar.style.width = '100%'; timerBar.className = 'timer-bar'; timerTextEl.textContent = timeLeft + 's';
    timerInterval = setInterval(() => {
      timeLeft--; timerTextEl.textContent = timeLeft + 's'; timerBar.style.width = ((timeLeft / TIMER_DURATION) * 100) + '%';
      if (timeLeft <= 5) timerBar.className = 'timer-bar timer-danger'; else if (timeLeft <= 10) timerBar.className = 'timer-bar timer-warning';
      if (timeLeft <= 0) { clearInterval(timerInterval); handleTimeUp(); }
    }, 1000);
  }
  function stopTimer() { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } }
  function handleTimeUp() { const val = answerInput.value.trim(); if (val) { submitAnswer(val); } else { if (currentQuestion) { answeredIds.push(currentQuestion.id); localStorage.setItem(STORAGE_KEY, JSON.stringify(answeredIds)); } loadNextQuestion(); } }
  async function submitAnswer(text) {
    btnSubmit.disabled = true; answerInput.disabled = true; stopTimer();
    try { await fetch('/api/answers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question_id: currentQuestion.id, text }) }); } catch {}
    answeredIds.push(currentQuestion.id); localStorage.setItem(STORAGE_KEY, JSON.stringify(answeredIds));
    showScreen('transition'); setTimeout(() => loadNextQuestion(), 800);
  }
  async function loadNextQuestion() {
    stopTimer();
    try { const data = await fetchNextQuestion(); if (data.done) { showScreen('done'); return; }
      currentQuestion = data; questionCount++; questionCounter.textContent = 'Question ' + questionCount; questionText.textContent = data.text;
      answerInput.value = ''; answerInput.disabled = false; btnSubmit.disabled = false; showScreen('question'); answerInput.focus(); startTimer();
    } catch { questionText.textContent = 'Erreur de chargement. Reessaie.'; showScreen('question'); }
  }
  btnStart.addEventListener('click', () => loadNextQuestion());
  answerForm.addEventListener('submit', (e) => { e.preventDefault(); const val = answerInput.value.trim(); if (!val || !currentQuestion) return; submitAnswer(val); });
})();
JSEOF

# --- public/js/admin.js ---
cat > public/js/admin.js << 'AJSEOF'
(function () {
  const views = { login: document.getElementById('view-login'), dashboard: document.getElementById('view-dashboard'), detail: document.getElementById('view-detail') };
  let categories = [], currentDetailId = null;
  function showView(name) { Object.values(views).forEach(v => v.classList.remove('active')); views[name].classList.add('active'); }
  async function api(url, opts = {}) { const res = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...opts.headers } }); if (res.status === 401) { showView('login'); throw new Error('Non autorise'); } return res; }
  function esc(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

  async function checkAuth() { const res = await fetch('/api/admin/check'); const data = await res.json(); if (data.authenticated) { showView('dashboard'); loadDashboard(); } else { showView('login'); } }

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const pw = document.getElementById('login-password').value;
    const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
    if (res.ok) { showView('dashboard'); loadDashboard(); } else { const err = document.getElementById('login-error'); err.textContent = 'Mot de passe incorrect'; err.style.display = 'block'; }
  });
  document.getElementById('btn-logout').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }); showView('login'); });

  async function loadDashboard() {
    const [statsRes, questionsRes, catsRes] = await Promise.all([api('/api/admin/stats'), api('/api/admin/questions'), api('/api/admin/categories')]);
    const stats = await statsRes.json(); const questions = await questionsRes.json(); categories = await catsRes.json();
    document.getElementById('stat-total').textContent = stats.totalAnswers;
    document.getElementById('stat-complete').textContent = stats.completeQuestions + '/' + stats.totalQuestions;
    const pct = stats.totalQuestions > 0 ? Math.round((questions.reduce((s, q) => s + Math.min(q.answer_count, stats.threshold), 0) / (stats.totalQuestions * stats.threshold)) * 100) : 0;
    document.getElementById('stat-progress').textContent = pct + '%'; document.getElementById('progress-bar').style.width = pct + '%';
    const catSelect = document.getElementById('form-category'); catSelect.innerHTML = '<option value="">-- Categorie --</option>';
    categories.forEach(c => { catSelect.innerHTML += '<option value="' + c.id + '">' + esc(c.name) + '</option>'; });
    const grouped = {}; questions.forEach(q => { if (!grouped[q.category_name]) grouped[q.category_name] = []; grouped[q.category_name].push(q); });
    const container = document.getElementById('questions-list'); container.innerHTML = '';
    for (const [catName, qs] of Object.entries(grouped)) {
      const section = document.createElement('div'); section.className = 'category-section';
      section.innerHTML = '<h3 class="category-title">' + esc(catName) + '</h3>';
      const list = document.createElement('div'); list.className = 'question-list';
      qs.forEach(q => {
        const pctQ = Math.min(100, Math.round((q.answer_count / stats.threshold) * 100)); const isDone = q.answer_count >= stats.threshold;
        const item = document.createElement('div'); item.className = 'question-item' + (isDone ? ' question-complete' : '');
        item.innerHTML = '<div class="question-item-text" data-id="' + q.id + '">' + esc(q.text) + '</div><div class="question-item-meta"><span class="answer-badge ' + (isDone ? 'badge-complete' : '') + '">' + q.answer_count + '/' + stats.threshold + '</span><div class="mini-progress"><div class="mini-bar" style="width:' + pctQ + '%"></div></div><button class="btn btn-ghost btn-xs" data-edit="' + q.id + '">&#9998;</button><button class="btn btn-ghost btn-xs" data-delete="' + q.id + '">&#128465;</button></div>';
        list.appendChild(item);
      });
      section.appendChild(list); container.appendChild(section);
    }
    container.querySelectorAll('[data-id]').forEach(el => { el.addEventListener('click', () => loadDetail(el.dataset.id)); });
    container.querySelectorAll('[data-edit]').forEach(el => { el.addEventListener('click', (e) => { e.stopPropagation(); const q = questions.find(x => x.id == el.dataset.edit); openEditForm(q); }); });
    container.querySelectorAll('[data-delete]').forEach(el => { el.addEventListener('click', async (e) => { e.stopPropagation(); if (!confirm('Supprimer cette question et toutes ses reponses ?')) return; await api('/api/admin/questions/' + el.dataset.delete, { method: 'DELETE' }); loadDashboard(); }); });
  }

  document.getElementById('btn-add-question').addEventListener('click', () => { document.getElementById('form-question-id').value = ''; document.getElementById('form-text').value = ''; document.getElementById('form-category').value = ''; document.getElementById('form-title').textContent = 'Ajouter une question'; document.getElementById('question-form-wrapper').style.display = 'block'; });
  document.getElementById('form-cancel').addEventListener('click', () => { document.getElementById('question-form-wrapper').style.display = 'none'; });
  function openEditForm(q) { document.getElementById('form-question-id').value = q.id; document.getElementById('form-text').value = q.text; document.getElementById('form-category').value = q.category_id; document.getElementById('form-title').textContent = 'Modifier la question'; document.getElementById('question-form-wrapper').style.display = 'block'; }
  document.getElementById('question-form').addEventListener('submit', async (e) => { e.preventDefault(); const id = document.getElementById('form-question-id').value; const text = document.getElementById('form-text').value.trim(); const cid = document.getElementById('form-category').value; if (!text || !cid) return alert('Remplis tous les champs'); if (id) { await api('/api/admin/questions/' + id, { method: 'PUT', body: JSON.stringify({ text, category_id: Number(cid) }) }); } else { await api('/api/admin/questions', { method: 'POST', body: JSON.stringify({ text, category_id: Number(cid) }) }); } document.getElementById('question-form-wrapper').style.display = 'none'; loadDashboard(); });

  async function loadDetail(id) {
    currentDetailId = id; const res = await api('/api/admin/questions/' + id + '/answers'); const data = await res.json();
    document.getElementById('detail-question-text').textContent = data.question.text;
    document.getElementById('detail-count').textContent = data.totalCount + '/100 reponses';
    document.getElementById('detail-category').textContent = data.question.category_name;
    const t5 = document.getElementById('top5-indicator'); let cls = 'top5-neutral', lbl = 'En attente (pas assez de donnees)';
    if (data.top5Status === 'good') { cls = 'top5-good'; lbl = 'Top 5 = ' + data.top5Pct + '% - Bonne repartition'; }
    else if (data.top5Status === 'concentrated') { cls = 'top5-concentrated'; lbl = 'Top 5 = ' + data.top5Pct + '% - Trop concentre'; }
    else if (data.top5Status === 'scattered') { cls = 'top5-scattered'; lbl = 'Top 5 = ' + data.top5Pct + '% - Trop eclate'; }
    t5.className = 'top5-indicator ' + cls; t5.textContent = lbl;
    const tbody = document.getElementById('answers-tbody'); tbody.innerHTML = '';
    data.answers.forEach((a, i) => { const tr = document.createElement('tr'); tr.innerHTML = '<td><input type="checkbox" class="answer-check" data-text="' + esc(a.normalized) + '"></td><td>' + (i + 1) + '</td><td>' + esc(a.sample_text) + '</td><td>' + a.count + '</td><td><div class="pct-bar-cell"><div class="pct-bar-fill" style="width:' + a.percentage + '%"></div><span>' + a.percentage + '%</span></div></td>'; tbody.appendChild(tr); });
    document.getElementById('merge-tool').style.display = 'none'; showView('detail'); updateMergeVisibility();
  }

  document.getElementById('select-all').addEventListener('change', (e) => { document.querySelectorAll('.answer-check').forEach(cb => cb.checked = e.target.checked); updateMergeVisibility(); });
  document.getElementById('answers-tbody').addEventListener('change', () => updateMergeVisibility());
  function updateMergeVisibility() { document.getElementById('merge-tool').style.display = document.querySelectorAll('.answer-check:checked').length >= 2 ? 'block' : 'none'; }
  document.getElementById('btn-merge').addEventListener('click', async () => { const checked = document.querySelectorAll('.answer-check:checked'); const texts = Array.from(checked).map(cb => cb.dataset.text); const canonical = document.getElementById('merge-canonical').value.trim(); if (!canonical) return alert('Donne un texte canonique'); await api('/api/admin/merge', { method: 'POST', body: JSON.stringify({ question_id: Number(currentDetailId), answer_texts: texts, canonical_text: canonical }) }); document.getElementById('merge-canonical').value = ''; loadDetail(currentDetailId); });
  document.getElementById('btn-back').addEventListener('click', () => { showView('dashboard'); loadDashboard(); });
  document.getElementById('btn-export').addEventListener('click', () => { window.location.href = '/api/admin/export'; });
  document.getElementById('btn-reset').addEventListener('click', async () => { if (!confirm('Supprimer TOUTES les reponses ?')) return; if (!confirm('Vraiment sur ?')) return; await api('/api/admin/reset', { method: 'POST' }); loadDashboard(); });
  checkAuth();
})();
AJSEOF

# --- public/css/style.css ---
cat > public/css/style.css << 'CSSEOF'
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0a12;--surface:#13131f;--surface2:#1a1a2e;--border:#2a2a40;--text:#e8e8f0;--text-dim:#8888a0;--accent:#8b5cf6;--accent-glow:rgba(139,92,246,0.3);--green:#22c55e;--yellow:#eab308;--red:#ef4444;--orange:#f97316;--radius:12px;--radius-sm:8px}
html{font-size:16px}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100dvh;line-height:1.5;-webkit-font-smoothing:antialiased}
.screen{display:none;min-height:100dvh;align-items:center;justify-content:center;padding:20px}
.screen.active{display:flex}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:32px 24px;width:100%;max-width:480px;text-align:center}
.title{font-size:2.4rem;font-weight:800;line-height:1.1;margin-bottom:8px}
.accent{color:var(--accent)}
.subtitle{color:var(--text-dim);margin-bottom:32px;font-size:1.05rem}
.rules{display:flex;flex-direction:column;gap:14px;margin-bottom:32px;text-align:left}
.rule{display:flex;align-items:center;gap:12px;font-size:.95rem;background:var(--surface2);padding:12px 16px;border-radius:var(--radius-sm)}
.rule-icon{font-size:1.2rem;flex-shrink:0;font-weight:bold;color:var(--accent)}
.btn{display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:var(--radius-sm);font-size:1rem;font-weight:600;cursor:pointer;transition:all .2s;padding:12px 24px;text-decoration:none;color:var(--text)}
.btn:active{transform:scale(.97)}
.btn-primary{background:var(--accent);color:#fff;box-shadow:0 0 20px var(--accent-glow)}
.btn-primary:hover{filter:brightness(1.1)}
.btn-primary:disabled{opacity:.5;cursor:not-allowed}
.btn-large{width:100%;padding:16px;font-size:1.1rem}
.btn-ghost{background:transparent;border:1px solid var(--border);color:var(--text-dim)}
.btn-ghost:hover{border-color:var(--accent);color:var(--text)}
.btn-danger{background:var(--red);color:#fff}
.btn-sm{padding:8px 14px;font-size:.85rem}
.btn-xs{padding:4px 8px;font-size:.8rem;background:none;border:none;cursor:pointer}
.input{width:100%;padding:14px 16px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:1rem;outline:none;transition:border-color .2s}
.input:focus{border-color:var(--accent)}
.input::placeholder{color:var(--text-dim)}
.textarea{resize:vertical;font-family:inherit}
select.input{cursor:pointer}
.question-card{position:relative;overflow:hidden}
.timer-container{position:absolute;top:0;left:0;right:0;height:4px;background:var(--surface2)}
.timer-bar{height:100%;background:var(--green);transition:width 1s linear;border-radius:0 2px 2px 0}
.timer-warning{background:var(--yellow)}
.timer-danger{background:var(--red);animation:pulse .5s infinite alternate}
@keyframes pulse{to{opacity:.6}}
.timer-text{font-size:.9rem;color:var(--text-dim);margin-top:12px;font-variant-numeric:tabular-nums}
.question-counter{font-size:.8rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;margin-top:8px}
.question-text{font-size:1.35rem;font-weight:700;margin:24px 0;line-height:1.35}
#answer-form{display:flex;flex-direction:column;gap:12px}
.transition-card{padding:40px}
.checkmark{width:60px;height:60px;border-radius:50%;background:var(--green);color:#fff;font-size:2rem;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;animation:pop .3s ease-out}
@keyframes pop{0%{transform:scale(0)}100%{transform:scale(1)}}
.done-icon{font-size:3rem;margin-bottom:16px}
.done-card h2{margin-bottom:12px}
.done-sub{color:var(--text-dim);font-size:.9rem;margin-top:8px}
.admin-body .screen{align-items:flex-start}
.admin-container{width:100%;max-width:900px;margin:0 auto;padding:24px 16px}
.admin-header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;margin-bottom:24px}
.admin-header h1{font-size:1.6rem}
.admin-actions{display:flex;flex-wrap:wrap;gap:8px}
.login-card{max-width:360px;margin:auto}
.login-card h1{margin-bottom:20px}
.login-card form{display:flex;flex-direction:column;gap:12px}
.error-text{color:var(--red);font-size:.85rem;margin-top:8px}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:20px 16px;text-align:center}
.stat-value{font-size:1.8rem;font-weight:800;color:var(--accent);font-variant-numeric:tabular-nums}
.stat-label{font-size:.8rem;color:var(--text-dim);margin-top:4px}
.progress-wrapper{height:6px;background:var(--surface2);border-radius:3px;margin-bottom:32px;overflow:hidden}
.progress-bar{height:100%;background:linear-gradient(90deg,var(--accent),var(--green));border-radius:3px;transition:width .5s}
.section{margin-bottom:32px}
.section-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.section-header h2{font-size:1.15rem}
.category-section{margin-bottom:20px}
.category-title{font-size:.85rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--accent);margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border)}
.question-list{display:flex;flex-direction:column;gap:6px}
.question-item{display:flex;justify-content:space-between;align-items:center;gap:12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;transition:border-color .2s}
.question-item:hover{border-color:var(--accent)}
.question-complete{border-left:3px solid var(--green)}
.question-item-text{flex:1;font-size:.92rem;cursor:pointer;line-height:1.4}
.question-item-meta{display:flex;align-items:center;gap:8px;flex-shrink:0}
.answer-badge{font-size:.75rem;font-weight:600;background:var(--surface2);padding:3px 8px;border-radius:4px;white-space:nowrap;font-variant-numeric:tabular-nums}
.badge-complete{background:var(--green);color:#000}
.mini-progress{width:40px;height:4px;background:var(--surface2);border-radius:2px;overflow:hidden}
.mini-bar{height:100%;background:var(--accent);border-radius:2px}
#question-form-wrapper{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px}
#question-form-wrapper h3{margin-bottom:14px;font-size:1rem}
#question-form{display:flex;flex-direction:column;gap:10px}
.form-actions{display:flex;gap:8px}
.detail-title{font-size:1.25rem;margin:16px 0 12px;line-height:1.35}
.detail-meta{display:flex;gap:12px;align-items:center;margin-bottom:16px;font-size:.9rem;color:var(--text-dim)}
.badge{font-size:.75rem;background:var(--accent);color:#fff;padding:3px 10px;border-radius:20px;font-weight:600}
.top5-indicator{padding:10px 16px;border-radius:var(--radius-sm);font-size:.9rem;font-weight:600;margin-bottom:20px}
.top5-neutral{background:var(--surface2);color:var(--text-dim)}
.top5-good{background:rgba(34,197,94,.15);color:var(--green);border:1px solid rgba(34,197,94,.3)}
.top5-concentrated{background:rgba(249,115,22,.15);color:var(--orange);border:1px solid rgba(249,115,22,.3)}
.top5-scattered{background:rgba(239,68,68,.15);color:var(--red);border:1px solid rgba(239,68,68,.3)}
.table-wrapper{overflow-x:auto;margin-bottom:20px}
.answers-table{width:100%;border-collapse:collapse;font-size:.9rem}
.answers-table th,.answers-table td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--border)}
.answers-table th{font-size:.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-dim);font-weight:600}
.answers-table tr:hover{background:var(--surface2)}
.answers-table input[type="checkbox"]{accent-color:var(--accent);width:16px;height:16px;cursor:pointer}
.pct-bar-cell{display:flex;align-items:center;gap:8px;min-width:100px}
.pct-bar-fill{height:6px;background:var(--accent);border-radius:3px;flex:1;max-width:80px}
.pct-bar-cell span{font-size:.8rem;font-variant-numeric:tabular-nums;white-space:nowrap}
.merge-tool{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:16px}
.merge-tool h3{font-size:.95rem;margin-bottom:10px}
.merge-tool .input{margin-bottom:10px}
@media(max-width:600px){.title{font-size:2rem}.question-text{font-size:1.15rem}.card{padding:24px 18px}.question-item{flex-direction:column;align-items:flex-start}.question-item-meta{width:100%;justify-content:flex-start;margin-top:6px}.admin-header{flex-direction:column;align-items:flex-start}.stats-grid{grid-template-columns:1fr 1fr}.pct-bar-cell{min-width:70px}}
CSSEOF

echo -e "${GREEN}Fichiers crees !${NC}"

# --- 6. Install dependencies ---
echo ""
echo -e "${BOLD}Installation des dependances npm...${NC}"
npm install
echo -e "${GREEN}Dependances installees !${NC}"

# --- 7. Git init ---
echo ""
echo -e "${BOLD}Initialisation git...${NC}"
git init
git add -A
git commit -m "Initial commit: Le Grand Sondage"

# --- 8. Create GitHub repo ---
echo ""
echo -e "${BOLD}Creation du repo GitHub...${NC}"
REPO_NAME="grand-sondage"
gh repo create "$REPO_NAME" --public --source=. --push

echo ""
echo -e "${GREEN}================================================${NC}"
echo -e "${GREEN}  Code pousse sur GitHub !${NC}"
echo -e "${GREEN}================================================${NC}"
echo ""
echo -e "${BOLD}DERNIERE ETAPE - Deploiement sur Render.com :${NC}"
echo ""
echo -e "1. Va sur ${BOLD}https://render.com${NC}"
echo -e "2. Clique ${BOLD}'Get Started for Free'${NC} puis ${BOLD}'GitHub'${NC}"
echo -e "3. Une fois connecte, clique ${BOLD}'New +'${NC} en haut puis ${BOLD}'Blueprint'${NC}"
echo -e "4. Selectionne ton repo ${BOLD}${REPO_NAME}${NC}"
echo -e "5. Clique ${BOLD}'Apply'${NC}"
echo -e "6. Attends 2-3 minutes..."
echo -e ""
echo -e "${GREEN}C'est tout ! Tu recevras une URL du type :${NC}"
echo -e "${BOLD}https://grand-sondage.onrender.com${NC}"
echo ""
echo -e "Admin : ${BOLD}https://grand-sondage.onrender.com/admin${NC}"
echo -e "Mot de passe admin : ${BOLD}clubsecret2026${NC}"
echo ""
