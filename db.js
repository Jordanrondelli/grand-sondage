const path = require('path');

const isPostgres = !!process.env.DATABASE_URL;
let pool, sqlite;

if (isPostgres) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
} else {
  try {
    const Database = require('better-sqlite3');
    sqlite = new Database(process.env.DB_PATH || path.join(__dirname, 'survey.db'));
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('busy_timeout = 5000');
    sqlite.pragma('synchronous = NORMAL');
  } catch (err) {
    console.error('better-sqlite3 not available:', err.message);
    console.error('Set DATABASE_URL for PostgreSQL or install better-sqlite3');
    process.exit(1);
  }
}

// --- Helpers ---

async function all(sql, params = []) {
  if (isPostgres) {
    const res = await pool.query(sql, params);
    return res.rows;
  } else {
    return sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params);
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
    const info = sqlite.prepare(sql.replace(/\$\d+/g, '?')).run(...params);
    return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
  }
}

async function runNoReturn(sql, params = []) {
  if (isPostgres) { await pool.query(sql, params); }
  else { sqlite.prepare(sql.replace(/\$\d+/g, '?')).run(...params); }
}

// --- Schema & Seed ---

async function init() {
  if (isPostgres) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS categories (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS questions (id SERIAL PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id), text TEXT NOT NULL, active INTEGER DEFAULT 1, skip_count INTEGER DEFAULT 0, rejected_count INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS answers (id SERIAL PRIMARY KEY, question_id INTEGER NOT NULL REFERENCES questions(id), text TEXT NOT NULL, response_time INTEGER, created_at TIMESTAMP DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id);
      CREATE TABLE IF NOT EXISTS banned_words (id SERIAL PRIMARY KEY, word TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS corrections (id SERIAL PRIMARY KEY, wrong TEXT NOT NULL UNIQUE, correct TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    await pool.query("ALTER TABLE questions ADD COLUMN IF NOT EXISTS skip_count INTEGER DEFAULT 0").catch(() => {});
    await pool.query("ALTER TABLE questions ADD COLUMN IF NOT EXISTS rejected_count INTEGER DEFAULT 0").catch(() => {});
    await pool.query("ALTER TABLE answers ADD COLUMN IF NOT EXISTS response_time INTEGER").catch(() => {});
  } else {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL, text TEXT NOT NULL, active INTEGER DEFAULT 1, skip_count INTEGER DEFAULT 0, rejected_count INTEGER DEFAULT 0, FOREIGN KEY (category_id) REFERENCES categories(id));
      CREATE TABLE IF NOT EXISTS answers (id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INTEGER NOT NULL, text TEXT NOT NULL, response_time INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (question_id) REFERENCES questions(id));
      CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id);
      CREATE TABLE IF NOT EXISTS banned_words (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS corrections (id INTEGER PRIMARY KEY AUTOINCREMENT, wrong TEXT NOT NULL UNIQUE, correct TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    try { sqlite.exec("ALTER TABLE questions ADD COLUMN skip_count INTEGER DEFAULT 0"); } catch {}
    try { sqlite.exec("ALTER TABLE questions ADD COLUMN rejected_count INTEGER DEFAULT 0"); } catch {}
    try { sqlite.exec("ALTER TABLE answers ADD COLUMN response_time INTEGER"); } catch {}
  }

  // One-time migration: replace old clubs with new ones
  const oldCat = await get("SELECT id FROM categories WHERE name = $1", ['années 2000']);
  if (oldCat) {
    await runNoReturn("DELETE FROM answers");
    await runNoReturn("DELETE FROM questions");
    await runNoReturn("DELETE FROM categories");
  }

  const row = await get('SELECT COUNT(*) as c FROM categories');
  if (Number(row.c) === 0) {
    await run("INSERT INTO categories (name) VALUES ($1)", ['vacances']);
    await run("INSERT INTO categories (name) VALUES ($1)", ['nourriture']);
    await run("INSERT INTO categories (name) VALUES ($1)", ['cinéma']);
  }

  // Seed questions (idempotent — skips duplicates)
  const cats = await all("SELECT * FROM categories");
  const catMap = {};
  cats.forEach(c => { catMap[c.name] = c.id; });

  const seedQuestions = [
    [catMap['vacances'], "Tu es au bar en vacances, qu'est-ce que tu commandes ?"],
    [catMap['vacances'], "Quel est LE pays où tu rêves d'aller ?"],
    [catMap['vacances'], "Quel est LE truc que tu oublies toujours dans ta valise ?"],
    [catMap['vacances'], "Quel est LE truc le plus énervant en avion ?"],
    [catMap['nourriture'], "Quel est L'aliment que tu manges en cachette dans le frigo ?"],
    [catMap['nourriture'], "Qu'est ce que tu commandes en livraison quand t'as la flemme de faire a manger ?"],
    [catMap['nourriture'], "Quel est LE truc que tu grignotes devant la télé ?"],
    [catMap['cinéma'], "Quel est LE méchant de film que tout le monde connaît ?"],
    [catMap['cinéma'], "Quel est ton genre de film préféré ? (horreur, comédie, science fiction, etc...)"],
    [catMap['cinéma'], "Quel est LE Disney que tu préfères ?"],
  ];

  for (const [catId, text] of seedQuestions) {
    if (!catId) continue;
    const exists = await get("SELECT id FROM questions WHERE text = $1", [text]);
    if (!exists) {
      await run("INSERT INTO questions (category_id, text) VALUES ($1, $2)", [catId, text]);
    }
  }

  // Seed banned words (idempotent)
  const seedBanned = ['jsp', 'je sais pas', 'aucune idée', "j'étais pas né", 'pas née', 'caca', 'hitler', 'pornhub', "n'importe quoi"];
  for (const w of seedBanned) {
    const exists = await get("SELECT id FROM banned_words WHERE word = $1", [w]);
    if (!exists) await runNoReturn("INSERT INTO banned_words (word) VALUES ($1)", [w]);
  }

  // Seed corrections (idempotent)
  const seedCorrections = [
    ['fesbook', 'facebook'], ['face book', 'facebook'], ['youtybe', 'youtube'],
    ['youtunes', 'youtube'], ['googel', 'google'], ['formage', 'fromage'],
    ['chocolay', 'chocolat'], ['saucision', 'saucisson'], ['sky blog', 'skyblog'],
    ['slyblog', 'skyblog'],
  ];
  for (const [w, c] of seedCorrections) {
    const exists = await get("SELECT id FROM corrections WHERE wrong = $1", [w]);
    if (!exists) await runNoReturn("INSERT INTO corrections (wrong, correct) VALUES ($1, $2)", [w, c]);
  }

  // Seed settings
  const am = await getSetting('auto_merge');
  if (am === null) await setSetting('auto_merge', '1');
}

// --- Queries ---

const THRESHOLD = 100;

async function getAvailableQuestion(excludeIds) {
  if (isPostgres) {
    const rows = await all(
      "SELECT q.id, q.text FROM questions q WHERE q.active = 1 AND (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) < $1 AND NOT (q.id = ANY($2::int[])) ORDER BY RANDOM() LIMIT 1",
      [THRESHOLD, excludeIds]
    );
    return rows[0] || null;
  } else {
    return sqlite.prepare(
      "SELECT q.id, q.text FROM questions q WHERE q.active = 1 AND (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) < ? AND q.id NOT IN (SELECT value FROM json_each(?)) ORDER BY RANDOM() LIMIT 1"
    ).get(THRESHOLD, JSON.stringify(excludeIds)) || null;
  }
}

async function insertAnswer(qid, text, responseTime) {
  await runNoReturn("INSERT INTO answers (question_id, text, response_time) VALUES ($1, $2, $3)", [qid, text, responseTime || null]);
}

async function incrementSkip(qid) {
  await runNoReturn("UPDATE questions SET skip_count = COALESCE(skip_count, 0) + 1 WHERE id = $1", [qid]);
}

async function getAnswerCount(qid) {
  return Number((await get("SELECT COUNT(*) as c FROM answers WHERE question_id = $1", [qid])).c);
}

async function getAllCategories() {
  return all("SELECT * FROM categories ORDER BY name");
}

async function getQuestionsWithCounts() {
  const rows = await all(
    "SELECT q.id, q.text, q.active, q.category_id, q.skip_count, q.rejected_count, c.name as category_name, (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) as answer_count, (SELECT ROUND(AVG(a.response_time)) FROM answers a WHERE a.question_id = q.id AND a.response_time IS NOT NULL) as avg_time FROM questions q JOIN categories c ON c.id = q.category_id ORDER BY c.name, q.id"
  );
  return rows.map(r => ({ ...r, answer_count: Number(r.answer_count), skip_count: Number(r.skip_count || 0), rejected_count: Number(r.rejected_count || 0), avg_time: r.avg_time ? Number(r.avg_time) : null }));
}

async function getQuestionById(id) {
  return get("SELECT q.*, c.name as category_name FROM questions q JOIN categories c ON c.id = q.category_id WHERE q.id = $1", [id]);
}

async function getAnswersGrouped(qid) {
  const rows = await all(
    "SELECT LOWER(TRIM(text)) as normalized, MIN(text) as sample_text, COUNT(*) as count FROM answers WHERE question_id = $1 GROUP BY LOWER(TRIM(text)) ORDER BY count DESC",
    [qid]
  );
  return rows.map(r => ({ ...r, count: Number(r.count) }));
}

async function getStats() {
  const totalAnswers = Number((await get("SELECT COUNT(*) as c FROM answers")).c);
  const completeQuestions = Number((await get(
    "SELECT COUNT(*) as c FROM questions q WHERE (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) >= $1", [THRESHOLD]
  )).c);
  const totalQuestions = Number((await get("SELECT COUNT(*) as c FROM questions WHERE active = 1")).c);
  return { totalAnswers, completeQuestions, totalQuestions, threshold: THRESHOLD };
}

async function insertQuestion(catId, text) {
  return run("INSERT INTO questions (category_id, text) VALUES ($1, $2)", [catId, text]);
}

async function updateQuestion(id, text, catId) {
  await runNoReturn("UPDATE questions SET text = $1, category_id = $2 WHERE id = $3", [text, catId, id]);
}

async function deleteQuestion(id) {
  await runNoReturn("DELETE FROM answers WHERE question_id = $1", [id]);
  await runNoReturn("DELETE FROM questions WHERE id = $1", [id]);
}

async function mergeAnswers(qid, texts, canonical) {
  const lowered = texts.map(t => t.toLowerCase().trim());
  if (isPostgres) {
    await pool.query(
      "UPDATE answers SET text = $1 WHERE question_id = $2 AND LOWER(TRIM(text)) = ANY($3::text[])",
      [canonical, qid, lowered]
    );
  } else {
    sqlite.prepare(
      "UPDATE answers SET text = ? WHERE question_id = ? AND LOWER(TRIM(text)) IN (SELECT value FROM json_each(?))"
    ).run(canonical, qid, JSON.stringify(lowered));
  }
}

async function getAllAnswersForExport() {
  const rows = await all(
    "SELECT q.id as question_id, c.name as club, q.text as question, LOWER(TRIM(a.text)) as answer, COUNT(*) as count, q.skip_count, (SELECT ROUND(AVG(a2.response_time)) FROM answers a2 WHERE a2.question_id = q.id AND a2.response_time IS NOT NULL) as avg_time FROM answers a JOIN questions q ON q.id = a.question_id JOIN categories c ON c.id = q.category_id GROUP BY q.id, c.name, q.text, LOWER(TRIM(a.text)), q.skip_count ORDER BY q.id, count DESC"
  );
  return rows.map(r => ({ ...r, count: Number(r.count), skip_count: Number(r.skip_count || 0), avg_time: r.avg_time ? Number(r.avg_time) : null }));
}

async function getSetting(key) {
  const row = await get("SELECT value FROM settings WHERE key = $1", [key]);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  if (isPostgres) {
    await pool.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, value]);
  } else {
    sqlite.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }
}

async function getExistingAnswers(qid) {
  const rows = await all("SELECT text, COUNT(*) as count FROM answers WHERE question_id = $1 GROUP BY text ORDER BY count DESC", [qid]);
  return rows.map(r => ({ text: r.text, count: Number(r.count) }));
}

async function incrementRejected(qid) {
  await runNoReturn("UPDATE questions SET rejected_count = COALESCE(rejected_count, 0) + 1 WHERE id = $1", [qid]);
}

async function getBannedWords() {
  return all("SELECT * FROM banned_words ORDER BY word");
}

async function addBannedWord(word) {
  if (isPostgres) {
    const res = await pool.query("INSERT INTO banned_words (word) VALUES ($1) ON CONFLICT (word) DO NOTHING RETURNING *", [word]);
    return res.rows[0] || (await get("SELECT * FROM banned_words WHERE word = $1", [word]));
  } else {
    sqlite.prepare("INSERT OR IGNORE INTO banned_words (word) VALUES (?)").run(word);
    return sqlite.prepare("SELECT * FROM banned_words WHERE word = ?").get(word);
  }
}

async function deleteBannedWord(id) {
  await runNoReturn("DELETE FROM banned_words WHERE id = $1", [id]);
}

async function getCorrections() {
  return all("SELECT * FROM corrections ORDER BY wrong");
}

async function addCorrection(wrong, correct) {
  if (isPostgres) {
    const res = await pool.query("INSERT INTO corrections (wrong, correct) VALUES ($1, $2) ON CONFLICT (wrong) DO UPDATE SET correct = EXCLUDED.correct RETURNING *", [wrong, correct]);
    return res.rows[0];
  } else {
    sqlite.prepare("INSERT OR REPLACE INTO corrections (wrong, correct) VALUES (?, ?)").run(wrong, correct);
    return sqlite.prepare("SELECT * FROM corrections WHERE wrong = ?").get(wrong);
  }
}

async function deleteCorrection(id) {
  await runNoReturn("DELETE FROM corrections WHERE id = $1", [id]);
}

async function deleteAllAnswers() {
  await runNoReturn("DELETE FROM answers");
}

async function insertCategory(name) {
  if (isPostgres) {
    const res = await pool.query("INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *", [name]);
    return res.rows[0] || (await get("SELECT * FROM categories WHERE name = $1", [name]));
  } else {
    sqlite.prepare("INSERT OR IGNORE INTO categories (name) VALUES (?)").run(name);
    return sqlite.prepare("SELECT * FROM categories WHERE name = ?").get(name);
  }
}

module.exports = {
  init, getAvailableQuestion, insertAnswer, incrementSkip, incrementRejected, getAnswerCount,
  getAllCategories, getQuestionsWithCounts, getQuestionById,
  getAnswersGrouped, getStats, insertQuestion, updateQuestion,
  deleteQuestion, mergeAnswers, getAllAnswersForExport,
  deleteAllAnswers, insertCategory,
  getBannedWords, addBannedWord, deleteBannedWord,
  getCorrections, addCorrection, deleteCorrection,
  getSetting, setSetting, getExistingAnswers,
  THRESHOLD,
};
