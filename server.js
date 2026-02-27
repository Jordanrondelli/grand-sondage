const express = require('express');
const session = require('express-session');
const compression = require('compression');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'clubsecret2026';

// --- Normalization & Validation ---

// Cache for banned words, corrections, settings (refreshed every 60s)
let bannedWordsCache = [];
let correctionsCache = [];
let autoMergeEnabled = true;
let cacheTime = 0;
async function refreshCache() {
  if (Date.now() - cacheTime < 60000) return;
  bannedWordsCache = await db.getBannedWords();
  correctionsCache = await db.getCorrections();
  const am = await db.getSetting('auto_merge');
  autoMergeEnabled = am !== '0';
  cacheTime = Date.now();
}
function invalidateCache() { cacheTime = 0; }

function normalizeAnswer(text) {
  let s = text
    .toLowerCase()
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f]/gu, '')
    .replace(/[^a-zà-ÿ0-9\s''\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Strip leading articles
  s = s.replace(/^(de la |de l'|du |des |les |le |la |l'|un |une )/i, '').trim();
  // Strip trailing laugh expressions
  s = s.replace(/\s+(lol|mdr|haha|xd|ptdr)$/i, '').trim();
  return s;
}

function containsBannedWord(text) {
  const lower = text.toLowerCase();
  for (const { word } of bannedWordsCache) {
    if (lower === word || lower.includes(word)) return true;
  }
  return false;
}

function applyCorrections(text) {
  for (const { wrong, correct } of correctionsCache) {
    if (text === wrong) return correct;
    const escaped = wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped, 'gi'), correct);
  }
  return text.trim();
}

function isGibberish(text) {
  const stripped = text.replace(/[\s'''-]/g, '');
  // Too short
  if (stripped.length < 3) return true;
  // Only repeated same character: "aaa", "..."
  if (/^(.)\1+$/.test(stripped)) return true;
  // No vowel at all — not a real word
  if (!/[aeiouyàâäéèêëïîôùûüÿœæ]/i.test(stripped)) return true;
  // 5+ consonants in a row — keyboard mash
  if (/[bcdfghjklmnpqrstvwxz]{5}/i.test(stripped)) return true;
  // Same consonant 3+ times in a row: "bbb", "kkk"
  if (/([bcdfghjklmnpqrstvwxz])\1{2}/i.test(stripped)) return true;
  // Single char dominance >50% (for 5+ chars): "ojojooi" → 'o' is 57%
  if (stripped.length >= 5) {
    const freq = {};
    for (const ch of stripped) freq[ch] = (freq[ch] || 0) + 1;
    if (Math.max(...Object.values(freq)) / stripped.length > 0.5) return true;
  }
  // Repeating short pattern 3+ times: "ababab", "hahaha"
  if (/^(.{1,3})\1{2,}/i.test(stripped)) return true;
  // Same vowel 3+ times in a row: "ooooj", "aaaa"
  if (/([aeiouyàâäéèêëïîôùûüÿœæ])\1{2}/i.test(stripped)) return true;
  // Long string with very few unique chars — keyboard spam: "ohoijhjhoijoi"
  if (stripped.length > 8 && new Set(stripped.toLowerCase()).size <= stripped.length / 3) return true;
  return false;
}

// --- Fuzzy Answer Matching ---

function deepNormalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .replace(/(.)\1+/g, '$1');
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const temp = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] !== b[j - 1] ? 1 : 0));
      prev = temp;
    }
  }
  return dp[m];
}

function areSimilar(a, b) {
  const na = deepNormalize(a);
  const nb = deepNormalize(b);
  if (na === nb) return true;
  if (na.startsWith(nb) || nb.startsWith(na)) return true;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return true;
  const dist = levenshtein(na, nb);
  const threshold = maxLen <= 5 ? 1 : Math.floor(maxLen * 0.3);
  return dist <= threshold;
}

// Find matching existing answer (>80% similarity) — returns existing text or null
function findMatchingAnswer(newText, existingAnswers) {
  const newNorm = deepNormalize(newText);
  for (const { text } of existingAnswers) {
    const existNorm = deepNormalize(text);
    if (newNorm === existNorm) return text;
    if (newNorm.startsWith(existNorm) || existNorm.startsWith(newNorm)) return text;
    const maxLen = Math.max(newNorm.length, existNorm.length);
    if (maxLen === 0) continue;
    const dist = levenshtein(newNorm, existNorm);
    if (dist / maxLen <= 0.2) return text; // 80% similar
  }
  return null;
}

// Cluster answers for CSV export (more permissive — 70% similarity)
function clusterAnswers(answers) {
  const clusters = [];
  for (const item of answers) {
    let merged = false;
    for (const cluster of clusters) {
      if (areSimilar(item.answer, cluster.canonical)) {
        cluster.count += item.count;
        if (item.count > cluster.maxCount) {
          cluster.canonical = item.answer;
          cluster.maxCount = item.count;
        }
        merged = true;
        break;
      }
    }
    if (!merged) {
      clusters.push({ canonical: item.answer, count: item.count, maxCount: item.count });
    }
  }
  return clusters.sort((a, b) => b.count - a.count).map(c => ({ answer: c.canonical, count: c.count }));
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
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false, saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 86400000 }
}));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// Health check (used by Render + external ping services)
app.get('/health', (req, res) => res.status(200).send('ok'));

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
    const { question_id, text, response_time } = req.body;
    if (!question_id || !text || typeof text !== 'string')
      return res.status(400).json({ error: 'Invalide' });

    await refreshCache();
    let normalized = normalizeAnswer(text);
    if (!normalized || normalized.length < 2 || normalized.length > 50) {
      await db.incrementRejected(question_id);
      return res.status(400).json({ error: 'Donne une vraie réponse 😉', troll: true });
    }
    const rt = (typeof response_time === 'number' && response_time > 0 && response_time <= 30) ? Math.round(response_time) : null;
    if (isGibberish(normalized) || containsBannedWord(normalized)) {
      await db.incrementRejected(question_id);
      return res.status(400).json({ error: 'Donne une vraie réponse 😉', troll: true });
    }

    // Apply auto-corrections
    normalized = applyCorrections(normalized);

    const count = await db.getAnswerCount(question_id);
    if (count >= db.THRESHOLD)
      return res.status(410).json({ error: 'Complet' });

    // Fuzzy match against existing answers (if enabled)
    if (autoMergeEnabled) {
      const existing = await db.getExistingAnswers(question_id);
      const match = findMatchingAnswer(normalized, existing);
      if (match) normalized = match;
    }

    await db.insertAnswer(question_id, normalized, rt);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/questions/:id/skip', rateLimit, async (req, res) => {
  try {
    await db.incrementSkip(req.params.id);
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
    const withPct = answers.map(a => ({
      ...a, percentage: totalCount > 0 ? (a.count / totalCount) * 100 : 0
    }));

    // 3 indicators
    const top1Pct = withPct[0]?.percentage || 0;
    const above2pct = withPct.filter(a => a.percentage >= 2).length;
    const top5Count = withPct.slice(0, 5).reduce((s, a) => s + a.count, 0);
    const top5Pct = totalCount > 0 ? (top5Count / totalCount) * 100 : 0;

    const trapClear = top1Pct >= 15;
    const stepsOk = above2pct >= 8 ? 'good' : above2pct >= 5 ? 'mid' : 'bad';
    const riskOk = top5Pct < 90;

    let checkCount = (trapClear ? 1 : 0) + (stepsOk === 'good' ? 1 : 0) + (riskOk ? 1 : 0);
    let verdict = checkCount >= 3 ? 'perfect' : checkCount >= 2 ? 'ok' : 'bad';

    res.json({
      question, answers: withPct, totalCount, top5Pct,
      indicators: { trapClear, top1Pct, stepsOk, above2pct, riskOk, verdict }
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

// --- Banned Words CRUD ---

app.get('/api/admin/banned-words', requireAdmin, async (req, res) => {
  try { res.json(await db.getBannedWords()); } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/admin/banned-words', requireAdmin, async (req, res) => {
  try {
    const { word } = req.body;
    if (!word?.trim()) return res.status(400).json({ error: 'Mot requis' });
    const result = await db.addBannedWord(word.trim().toLowerCase());
    invalidateCache();
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.delete('/api/admin/banned-words/:id', requireAdmin, async (req, res) => {
  try { await db.deleteBannedWord(req.params.id); invalidateCache(); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

// --- Corrections CRUD ---

app.get('/api/admin/corrections', requireAdmin, async (req, res) => {
  try { res.json(await db.getCorrections()); } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/admin/corrections', requireAdmin, async (req, res) => {
  try {
    const { wrong, correct } = req.body;
    if (!wrong?.trim() || !correct?.trim()) return res.status(400).json({ error: 'Requis' });
    const result = await db.addCorrection(wrong.trim().toLowerCase(), correct.trim().toLowerCase());
    invalidateCache();
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.delete('/api/admin/corrections/:id', requireAdmin, async (req, res) => {
  try { await db.deleteCorrection(req.params.id); invalidateCache(); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

// --- Settings ---

app.get('/api/admin/settings/auto-merge', requireAdmin, async (req, res) => {
  try {
    const val = await db.getSetting('auto_merge');
    res.json({ enabled: val !== '0' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.put('/api/admin/settings/auto-merge', requireAdmin, async (req, res) => {
  try {
    const { enabled } = req.body;
    await db.setSetting('auto_merge', enabled ? '1' : '0');
    invalidateCache();
    res.json({ ok: true, enabled: !!enabled });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.get('/api/admin/export', requireAdmin, async (req, res) => {
  try {
    const rows = await db.getAllAnswersForExport();
    // Group by question
    const byQuestion = {};
    rows.forEach(r => {
      if (!byQuestion[r.question_id]) {
        byQuestion[r.question_id] = {
          question_id: r.question_id, club: r.club, question: r.question,
          skip_count: r.skip_count, avg_time: r.avg_time, answers: []
        };
      }
      byQuestion[r.question_id].answers.push({ answer: r.answer, count: r.count });
    });

    const e = s => '"' + String(s).replace(/"/g, '""') + '"';
    let csv = '\uFEFFquestion_id,club,question,réponse,count,pourcentage,skips,temps_moyen_sec\n';

    for (const qid of Object.keys(byQuestion).sort((a, b) => a - b)) {
      const q = byQuestion[qid];
      const clustered = clusterAnswers(q.answers);
      const total = clustered.reduce((s, a) => s + a.count, 0);
      for (const a of clustered) {
        const p = total > 0 ? ((a.count / total) * 100).toFixed(1) : '0.0';
        csv += `${q.question_id},${e(q.club)},${e(q.question)},${e(a.answer)},${a.count},${p}%,${q.skip_count},${q.avg_time || ''}\n`;
      }
    }

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
