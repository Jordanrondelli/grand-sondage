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
      CREATE TABLE IF NOT EXISTS questions (id SERIAL PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id), text TEXT NOT NULL, active INTEGER DEFAULT 1, skip_count INTEGER DEFAULT 0, rejected_count INTEGER DEFAULT 0, variant_group INTEGER DEFAULT NULL);
      CREATE TABLE IF NOT EXISTS answers (id SERIAL PRIMARY KEY, question_id INTEGER NOT NULL REFERENCES questions(id), text TEXT NOT NULL, response_time INTEGER, created_at TIMESTAMP DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id);
      CREATE TABLE IF NOT EXISTS banned_words (id SERIAL PRIMARY KEY, word TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS corrections (id SERIAL PRIMARY KEY, wrong TEXT NOT NULL UNIQUE, correct TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tournage_questions (id SERIAL PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id), text TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS tournage_answers (id SERIAL PRIMARY KEY, tq_id INTEGER NOT NULL REFERENCES tournage_questions(id) ON DELETE CASCADE, text TEXT NOT NULL, count INTEGER DEFAULT 0, percentage REAL DEFAULT 0);
    `);
    await pool.query("ALTER TABLE questions ADD COLUMN IF NOT EXISTS skip_count INTEGER DEFAULT 0").catch(() => {});
    await pool.query("ALTER TABLE questions ADD COLUMN IF NOT EXISTS rejected_count INTEGER DEFAULT 0").catch(() => {});
    await pool.query("ALTER TABLE answers ADD COLUMN IF NOT EXISTS response_time INTEGER").catch(() => {});
    await pool.query("ALTER TABLE questions ADD COLUMN IF NOT EXISTS variant_group INTEGER DEFAULT NULL").catch(() => {});
    await pool.query("ALTER TABLE tournage_questions ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0").catch(() => {});
  } else {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL, text TEXT NOT NULL, active INTEGER DEFAULT 1, skip_count INTEGER DEFAULT 0, rejected_count INTEGER DEFAULT 0, FOREIGN KEY (category_id) REFERENCES categories(id));
      CREATE TABLE IF NOT EXISTS answers (id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INTEGER NOT NULL, text TEXT NOT NULL, response_time INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (question_id) REFERENCES questions(id));
      CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id);
      CREATE TABLE IF NOT EXISTS banned_words (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS corrections (id INTEGER PRIMARY KEY AUTOINCREMENT, wrong TEXT NOT NULL UNIQUE, correct TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tournage_questions (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL, text TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (category_id) REFERENCES categories(id));
      CREATE TABLE IF NOT EXISTS tournage_answers (id INTEGER PRIMARY KEY AUTOINCREMENT, tq_id INTEGER NOT NULL, text TEXT NOT NULL, count INTEGER DEFAULT 0, percentage REAL DEFAULT 0, FOREIGN KEY (tq_id) REFERENCES tournage_questions(id) ON DELETE CASCADE);
    `);
    try { sqlite.exec("ALTER TABLE questions ADD COLUMN skip_count INTEGER DEFAULT 0"); } catch {}
    try { sqlite.exec("ALTER TABLE questions ADD COLUMN rejected_count INTEGER DEFAULT 0"); } catch {}
    try { sqlite.exec("ALTER TABLE answers ADD COLUMN response_time INTEGER"); } catch {}
    try { sqlite.exec("ALTER TABLE questions ADD COLUMN variant_group INTEGER DEFAULT NULL"); } catch {}
    try { sqlite.exec("ALTER TABLE tournage_questions ADD COLUMN sort_order INTEGER DEFAULT 0"); } catch {}
  }

  // One-time migration: replace old clubs with new ones
  const oldCat = await get("SELECT id FROM categories WHERE name = $1", ['vacances']);
  if (oldCat) {
    await runNoReturn("DELETE FROM answers");
    await runNoReturn("DELETE FROM questions");
    await runNoReturn("DELETE FROM categories");
  }

  const row = await get('SELECT COUNT(*) as c FROM categories');
  if (Number(row.c) === 0) {
    await run("INSERT INTO categories (name) VALUES ($1)", ['Le Glouton Club']);
    await run("INSERT INTO categories (name) VALUES ($1)", ['Metronomus']);
    await run("INSERT INTO categories (name) VALUES ($1)", ['Red carpet']);
    await run("INSERT INTO categories (name) VALUES ($1)", ['La situation']);
  }

  // Fix: these two questions were incorrectly in variant_group 2
  await runNoReturn("UPDATE questions SET variant_group = NULL WHERE variant_group = 2 AND text = $1", ["Cite un fruit de mer"]);
  await runNoReturn("UPDATE questions SET variant_group = NULL WHERE variant_group = 2 AND text = $1", ["Qu'est ce qu'on mange et qui vient de la mer ?"]);

  // Seed questions (idempotent — skips duplicates)
  // Format: [categoryName, variantGroup (null if no variants), text]
  const cats = await all("SELECT * FROM categories");
  const catMap = {};
  cats.forEach(c => { catMap[c.name] = c.id; });

  const seedQuestions = [
    // --- Le Glouton Club ---
    [catMap['Le Glouton Club'], 1, "Une variété de pâtes ?"],
    [catMap['Le Glouton Club'], 1, "Un plat de pâtes ?"],
    [catMap['Le Glouton Club'], null, "Cite un fruit de mer"],
    [catMap['Le Glouton Club'], null, "Qu'est ce qu'on mange et qui vient de la mer ?"],
    [catMap['Le Glouton Club'], 3, "Qu'est ce qui t'énerve le plus au restaurant ?"],
    [catMap['Le Glouton Club'], 3, "Qu'est ce qui peut te décevoir au restaurant ?"],
    [catMap['Le Glouton Club'], 3, "Quelle situation peut te faire quitter un restaurant ?"],
    [catMap['Le Glouton Club'], 3, "Qu'est ce qui peut te faire mettre 1 étoile à un restaurant ?"],
    [catMap['Le Glouton Club'], null, "Avec qui préfères-tu aller au restaurant ?"],
    [catMap['Le Glouton Club'], null, "Un ustensile de cuisine ?"],
    [catMap['Le Glouton Club'], null, "Quelle est ta cuisine du monde préférée ? (pays d'origine)"],
    [catMap['Le Glouton Club'], null, "Quel animal serais-tu curieux de goûter ?"],
    [catMap['Le Glouton Club'], null, "Cite un aliment que tu détestes."],
    [catMap['Le Glouton Club'], null, "Quelle est la première chose que tu manges le matin ?"],
    [catMap['Le Glouton Club'], 4, "Il est minuit, tu as une petite faim, tu ouvres ton frigo, qu'est ce que tu prends instinctivement ?"],
    [catMap['Le Glouton Club'], 4, "Il est minuit, tu as une petite faim, tu ne veux pas te faire à manger, qu'est ce que tu grignotes ?"],
    [catMap['Le Glouton Club'], null, "Une sauce que tu aimes."],
    [catMap['Le Glouton Club'], 5, "Un aliment impossible à manger de manière sexy ?"],
    [catMap['Le Glouton Club'], 5, "Quelque chose que tu ne mangeras jamais pendant un date ?"],
    [catMap['Le Glouton Club'], null, "Quel aliment te fais penser à une haleine de poney ?"],
    [catMap['Le Glouton Club'], null, "Un aliment ou un plat qui te réconforte ?"],
    [catMap['Le Glouton Club'], null, "Jusqu'à combien de jours après la date de péremption vous pouvez manger un yaourt ?"],
    [catMap['Le Glouton Club'], null, "La pire chose à trouver dans son assiette au restaurant ?"],
    [catMap['Le Glouton Club'], null, "Quel plat te fais regretter de l'avoir manger ?"],
    [catMap['Le Glouton Club'], null, "Quel aliment ne devrait pas se trouver sur une pizza ?"],
    [catMap['Le Glouton Club'], null, "Qu'est ce qui se mange en apéritif ?"],
    [catMap['Le Glouton Club'], null, "Qu'est-ce qui se grille au barbecue l'été ?"],
    [catMap['Le Glouton Club'], null, "Tu dois demander l'addition au restaurant, que fais-tu ?"],
    [catMap['Le Glouton Club'], null, "Une spécialité culinaire française ? (plats principaux salés)"],
    // --- Metronomus ---
    [catMap['Metronomus'], null, "Un instrument de musique ?"],
    [catMap['Metronomus'], null, "Un genre de musique ?"],
    [catMap['Metronomus'], 6, "Quelle musique tu mets pour ambiancer tout le monde en soirée ? (titre et artiste)"],
    [catMap['Metronomus'], 6, "La soirée bat son plein, tu passes la prochaine musique, qu'est-ce que tu mets ?"],
    [catMap['Metronomus'], 6, "La soirée bat son plein, tu dois passer la prochaine musique, quel artiste va plaire à tout le monde ?"],
    [catMap['Metronomus'], null, "Une musique intemporelle ?"],
    [catMap['Metronomus'], null, "Tu t'occupes de la musique d'un enterrement, qu'est ce que tu mets pour l'arrivée du cercueil ?"],
    [catMap['Metronomus'], null, "Le plus grand artiste de tous les temps ?"],
    [catMap['Metronomus'], null, "Le meilleur endroit pour écouter ta musique ?"],
    [catMap['Metronomus'], 7, "Un objet pour mimer un micro ?"],
    [catMap['Metronomus'], 7, "Un instrument facile à mimer ?"],
    [catMap['Metronomus'], null, "Meilleure chanson à chanter au karaoké ?"],
    [catMap['Metronomus'], null, "L'artiste musical que vous mettez en fond pour baiser ?"],
    [catMap['Metronomus'], null, "La musique la plus ringarde ?"],
    [catMap['Metronomus'], null, "La meilleure comptine de tous les temps ?"],
    [catMap['Metronomus'], null, "Quel Disney a la meilleure musique ?"],
    [catMap['Metronomus'], null, "Un artiste musical cancel ?"],
    [catMap['Metronomus'], null, "De quel artiste musical détestes-tu les musiques ?"],
    [catMap['Metronomus'], null, "Quelqu'un te fait écouter sa musique c'est pas dingue, qu'est ce que tu lui dis pour pas lui faire de la peine ?"],
    [catMap['Metronomus'], null, "Quel youtubeur a fait la pire musique ?"],
    [catMap['Metronomus'], 8, "Une danse ?"],
    [catMap['Metronomus'], 8, "Un type de danse ?"],
    [catMap['Metronomus'], null, "Une note de musique ?"],
    // --- Red carpet ---
    [catMap['Red carpet'], null, "Un genre de film ?"],
    [catMap['Red carpet'], null, "Qu'est ce que tu prends au cinéma ? (sauf le popcorn)"],
    [catMap['Red carpet'], null, "Un méchant de film ?"],
    [catMap['Red carpet'], null, "Donne l'acteur ou l'actrice que tu trouves le plus beau/belle"],
    [catMap['Red carpet'], null, "Un chien populaire de films, séries ou dessins animés ?"],
    [catMap['Red carpet'], null, "Un film qui fait pleurer ?"],
    [catMap['Red carpet'], 9, "Un objet culte du cinéma ?"],
    [catMap['Red carpet'], 9, "Un objet de film que tu aimerais avoir dans la vraie vie ?"],
    [catMap['Red carpet'], null, "Un film français ?"],
    [catMap['Red carpet'], null, "Qu'est ce qui peut t'énerver quand tu regardes un film avec quelqu'un ?"],
    [catMap['Red carpet'], null, "Quel youtubeur serait le meilleur acteur ?"],
    [catMap['Red carpet'], null, "Qu'est ce que tu dirais pour te faire passer pour un cinéphile ?"],
    [catMap['Red carpet'], null, "Une série (dessin animé ou réel) dont tu connais le générique par coeur ?"],
    [catMap['Red carpet'], null, "Une réplique de film ?"],
    [catMap['Red carpet'], 10, "L'émotion la plus dure à jouer ?"],
    [catMap['Red carpet'], 10, "Une émotion qu'un acteur ou une actrice peut jouer ?"],
    // --- La situation ---
    [catMap['La situation'], 11, "C'est quoi le plus important dans la vie ?"],
    [catMap['La situation'], 11, "Qu'est ce qui te rend heureux dans la vie ?"],
    [catMap['La situation'], null, "Une insulte ? (courte)"],
    [catMap['La situation'], null, "Une drogue ou une addiction ? (légale ou illégale)"],
    // --- V2 questions ---
    // Le Glouton Club
    [catMap['Le Glouton Club'], null, "[V2] Une variété de pâtes ?"],
    [catMap['Le Glouton Club'], null, "[V2] Un ustensile de cuisine ?"],
    [catMap['Le Glouton Club'], null, "[V2] Quelle est ta cuisine du monde préférée ? (pays d'origine)"],
    [catMap['Le Glouton Club'], null, "[V2] Quel animal serais-tu curieux de goûter ?"],
    [catMap['Le Glouton Club'], null, "[V2] Quelque choses que tu ne mangeras jamais pendant un date ?"],
    [catMap['Le Glouton Club'], null, "[V2] Une spécialité culinaire française ? (plats principaux salés)"],
    // Metronomus
    [catMap['Metronomus'], null, "[V2] Un instrument de musique ?"],
    [catMap['Metronomus'], null, "[V2] Un artiste musical cancel ?"],
    [catMap['Metronomus'], null, "[V2] La soirée bat son plein, tu dois passer la prochaine musique, quel artiste va plaire à tout le monde ?"],
    [catMap['Metronomus'], null, "[V2] L'artiste musical que vous mettez en fond pour baiser ?"],
    [catMap['Metronomus'], null, "[V2] Une danse ?"],
    [catMap['Metronomus'], null, "[V2] Quel youtubeur à fait la pire musique ?"],
    // Red carpet
    [catMap['Red carpet'], null, "[V2] Un genre de film ?"],
    [catMap['Red carpet'], null, "[V2] Un méchant de film ?"],
    [catMap['Red carpet'], null, "[V2] Une série (dessin animé ou réel) dont tu connais le générique par coeur ?"],
    [catMap['Red carpet'], null, "[V2] L'émotion la plus dure à jouer ?"],
    [catMap['Red carpet'], null, "[V2] Un chien populaire de films, séries ou dessins animés ?"],
    [catMap['Red carpet'], null, "[V2] Un objet de film que tu aimerais avoir dans la vraie vie ?"],
    // La situation
    [catMap['La situation'], null, "[V2] Qu'est ce qui te rend heureux dans la vie ?"],
    [catMap['La situation'], null, "[V2] Cite une insulte"],
    [catMap['La situation'], null, "[V2] Cite une drogue/une addiction (légale ou illégale)"],
  ];

  for (const [catId, variantGroup, text] of seedQuestions) {
    if (!catId) continue;
    const exists = await get("SELECT id FROM questions WHERE text = $1", [text]);
    if (!exists) {
      if (variantGroup !== null) {
        await run("INSERT INTO questions (category_id, text, variant_group) VALUES ($1, $2, $3)", [catId, text, variantGroup]);
      } else {
        await run("INSERT INTO questions (category_id, text) VALUES ($1, $2)", [catId, text]);
      }
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

const THRESHOLD = 1000;

async function getAvailableQuestion(excludeIds) {
  // Also exclude questions that share a variant_group with any already-answered question
  if (isPostgres) {
    const rows = await all(
      `SELECT q.id, q.text, c.name as club, q.variant_group FROM questions q JOIN categories c ON c.id = q.category_id
       WHERE q.active = 1
         AND (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) < $1
         AND NOT (q.id = ANY($2::int[]))
         AND (q.variant_group IS NULL OR q.variant_group NOT IN (
           SELECT DISTINCT q2.variant_group FROM questions q2 WHERE q2.variant_group IS NOT NULL AND q2.id = ANY($2::int[])
         ))
       ORDER BY RANDOM() LIMIT 1`,
      [THRESHOLD, excludeIds]
    );
    return rows[0] || null;
  } else {
    return sqlite.prepare(
      `SELECT q.id, q.text, c.name as club, q.variant_group FROM questions q JOIN categories c ON c.id = q.category_id
       WHERE q.active = 1
         AND (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) < ?
         AND q.id NOT IN (SELECT value FROM json_each(?))
         AND (q.variant_group IS NULL OR q.variant_group NOT IN (
           SELECT DISTINCT q2.variant_group FROM questions q2 WHERE q2.variant_group IS NOT NULL AND q2.id IN (SELECT value FROM json_each(?))
         ))
       ORDER BY RANDOM() LIMIT 1`
    ).get(THRESHOLD, JSON.stringify(excludeIds), JSON.stringify(excludeIds)) || null;
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
    "SELECT q.id, q.text, q.active, q.category_id, q.skip_count, q.rejected_count, q.variant_group, c.name as category_name, (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) as answer_count, (SELECT ROUND(AVG(a.response_time)) FROM answers a WHERE a.question_id = q.id AND a.response_time IS NOT NULL) as avg_time FROM questions q JOIN categories c ON c.id = q.category_id ORDER BY c.name, q.id"
  );
  return rows.map(r => ({ ...r, answer_count: Number(r.answer_count), skip_count: Number(r.skip_count || 0), rejected_count: Number(r.rejected_count || 0), avg_time: r.avg_time ? Number(r.avg_time) : null, variant_group: r.variant_group || null }));
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

async function insertQuestion(catId, text, variantGroup) {
  if (variantGroup) {
    return run("INSERT INTO questions (category_id, text, variant_group) VALUES ($1, $2, $3)", [catId, text, variantGroup]);
  }
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

async function getTotalParticipantCount() {
  const row = await get("SELECT COUNT(*) as c FROM answers");
  return Number(row.c);
}

async function getAnswersWithScores(qid) {
  const rows = await all(
    "SELECT LOWER(TRIM(text)) as normalized, MIN(text) as sample_text, COUNT(*) as count FROM answers WHERE question_id = $1 GROUP BY LOWER(TRIM(text)) ORDER BY count DESC",
    [qid]
  );
  const mapped = rows.map(r => ({ ...r, count: Number(r.count) }));
  const total = mapped.reduce((s, a) => s + a.count, 0);
  return mapped.map(a => ({
    text: a.sample_text,
    normalized: a.normalized,
    count: a.count,
    score: total > 0 ? Math.round((a.count / total) * 100) : 0
  }));
}

async function getQuestionsByCategory(catId) {
  return (await all(
    "SELECT q.id, q.text, (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) as answer_count FROM questions q WHERE q.category_id = $1 AND q.active = 1 ORDER BY q.id",
    [catId]
  )).map(r => ({ ...r, answer_count: Number(r.answer_count) }));
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

async function updateCategory(id, name) {
  await runNoReturn("UPDATE categories SET name = $1 WHERE id = $2", [name, id]);
}

// --- Tournage (separate from survey) ---

async function getTournageQuestions(catId) {
  const rows = await all(
    "SELECT tq.id, tq.text, tq.category_id, tq.sort_order, (SELECT COUNT(*) FROM tournage_answers ta WHERE ta.tq_id = tq.id) as answer_count FROM tournage_questions tq WHERE tq.category_id = $1 ORDER BY tq.sort_order, tq.id",
    [catId]
  );
  return rows.map(r => ({ ...r, answer_count: Number(r.answer_count) }));
}

async function getTournageQuestion(id) {
  return get("SELECT tq.*, c.name as category_name FROM tournage_questions tq JOIN categories c ON c.id = tq.category_id WHERE tq.id = $1", [id]);
}

async function getTournageAnswers(tqId) {
  return (await all("SELECT * FROM tournage_answers WHERE tq_id = $1 ORDER BY count DESC", [tqId]))
    .map(r => ({ ...r, count: Number(r.count), percentage: Number(r.percentage) }));
}

async function insertTournageQuestion(catId, text) {
  return run("INSERT INTO tournage_questions (category_id, text) VALUES ($1, $2)", [catId, text]);
}

async function renameTournageQuestion(id, text) {
  await runNoReturn("UPDATE tournage_questions SET text = $1 WHERE id = $2", [text, id]);
}

async function deleteTournageQuestion(id) {
  await runNoReturn("DELETE FROM tournage_answers WHERE tq_id = $1", [id]);
  await runNoReturn("DELETE FROM tournage_questions WHERE id = $1", [id]);
}

async function clearTournageAnswers(tqId) {
  await runNoReturn("DELETE FROM tournage_answers WHERE tq_id = $1", [tqId]);
}

async function insertTournageAnswer(tqId, text, count, percentage) {
  await runNoReturn("INSERT INTO tournage_answers (tq_id, text, count, percentage) VALUES ($1, $2, $3, $4)", [tqId, text, count, percentage]);
}

async function reorderTournageQuestions(orderedIds) {
  for (let i = 0; i < orderedIds.length; i++) {
    await runNoReturn("UPDATE tournage_questions SET sort_order = $1 WHERE id = $2", [i, orderedIds[i]]);
  }
}

module.exports = {
  init, getAvailableQuestion, insertAnswer, incrementSkip, incrementRejected, getAnswerCount,
  getAllCategories, getQuestionsWithCounts, getQuestionById,
  getAnswersGrouped, getStats, insertQuestion, updateQuestion,
  deleteQuestion, mergeAnswers, getAllAnswersForExport,
  deleteAllAnswers, insertCategory, updateCategory,
  getBannedWords, addBannedWord, deleteBannedWord,
  getCorrections, addCorrection, deleteCorrection,
  getSetting, setSetting, getExistingAnswers,
  getTotalParticipantCount, getAnswersWithScores, getQuestionsByCategory,
  getTournageQuestions, getTournageQuestion, getTournageAnswers,
  insertTournageQuestion, renameTournageQuestion, deleteTournageQuestion, clearTournageAnswers, insertTournageAnswer, reorderTournageQuestions,
  THRESHOLD,
};
