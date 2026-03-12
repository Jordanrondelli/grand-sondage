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

// Cache for banned words, settings (refreshed every 60s)
let bannedWordsCache = [];
let autoMergeEnabled = true;
let cacheTime = 0;
async function refreshCache() {
  if (Date.now() - cacheTime < 60000) return;
  bannedWordsCache = await db.getBannedWords();
  const am = await db.getSetting('auto_merge');
  autoMergeEnabled = am !== '0';
  cacheTime = Date.now();
}
function invalidateCache() { cacheTime = 0; }

function normalizeAnswer(text) {
  // Raw answer — only trim whitespace and remove emojis
  let s = text
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

function containsBannedWord(text) {
  const lower = text.toLowerCase();
  for (const { word } of bannedWordsCache) {
    if (lower === word || lower.includes(word)) return true;
  }
  return false;
}

function isGibberish(text) {
  const stripped = text.replace(/[\s'''-]/g, '');
  if (stripped.length < 2) return true;
  if (/^(.)\1+$/.test(stripped)) return true;
  if (!/[aeiouyàâäéèêëïîôùûüÿœæ0-9]/i.test(stripped)) return true;
  if (/[bcdfghjklmnpqrstvwxz]{5}/i.test(stripped)) return true;
  if (/([bcdfghjklmnpqrstvwxz])\1{2}/i.test(stripped)) return true;
  if (stripped.length >= 6) {
    const freq = {};
    for (const ch of stripped) freq[ch] = (freq[ch] || 0) + 1;
    if (Math.max(...Object.values(freq)) / stripped.length > 0.6) return true;
  }
  if (/^(.{1,3})\1{2,}$/i.test(stripped)) return true;
  if (/([aeiouyàâäéèêëïîôùûüÿœæ])\1{2}/i.test(stripped)) return true;
  return false;
}

// --- Fuzzy Answer Matching ---

function deepNormalize(text) {
  let s = text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
  s = s.replace(/ph/g, 'f')
    .replace(/qu/g, 'k')
    .replace(/ck/g, 'k')
    .replace(/ss/g, 's')
    .replace(/eau/g, 'o')
    .replace(/au/g, 'o')
    .replace(/ou/g, 'u');
  s = s.replace(/(.)\1+/g, '$1');
  return s;
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
  const threshold = maxLen <= 4 ? 1 : Math.ceil(maxLen * 0.4);
  return dist <= threshold;
}

function findMatchingAnswer(newText, existingAnswers) {
  const newNorm = deepNormalize(newText);
  let bestMatch = null, bestDist = Infinity;
  for (const { text, count } of existingAnswers) {
    const existNorm = deepNormalize(text);
    if (newNorm === existNorm) return text;
    if (newNorm.startsWith(existNorm) || existNorm.startsWith(newNorm)) return text;
    const maxLen = Math.max(newNorm.length, existNorm.length);
    if (maxLen === 0) continue;
    const dist = levenshtein(newNorm, existNorm);
    const ratio = dist / maxLen;
    if (ratio <= 0.35 && dist < bestDist) {
      bestDist = dist;
      bestMatch = text;
    }
  }
  return bestMatch;
}

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
app.use(compression({ filter: (req, res) => {
  if (req.headers.accept === 'text/event-stream') return false;
  return compression.filter(req, res);
}}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false, saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 86400000 }
}));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// Health check
app.get('/health', (req, res) => res.status(200).send('ok'));

// Debug endpoint — diagnose survey issues
app.get('/api/debug/survey', async (req, res) => {
  try {
    const id = Number(req.query.s);
    if (!id || isNaN(id)) return res.json({ error: 'Pass ?s=<survey_id>' });
    const allSurveys = await db.getAllSurveys();
    const survey = allSurveys.find(s => s.id === id);
    const questionIds = survey ? await db.getSurveyQuestionIds(id) : [];
    let testQuestion = null, testError = null;
    if (survey) {
      try { testQuestion = await db.getAvailableQuestion(id, [], 'femme', 25); }
      catch (e) { testError = e.message; }
    }
    res.json({
      surveyId: id,
      surveyExists: !!survey,
      surveyActive: survey ? survey.active : null,
      surveyActiveType: survey ? typeof survey.active : null,
      activeCheckResult: survey ? !!Number(survey.active) : false,
      linkedQuestionCount: questionIds.length,
      allSurveys: allSurveys.map(s => ({ id: s.id, name: s.name, active: s.active, activeType: typeof s.active })),
      testQuestion,
      testError
    });
  } catch (e) { res.status(500).json({ error: e.message, stack: e.stack }); }
});

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  res.status(401).json({ error: 'Non autorisé' });
}

// --- Helper: resolve survey ID from ?s= param or active survey ---
async function getActiveSurveyId() {
  const s = await db.getActiveSurvey();
  return s ? s.id : null;
}

async function resolveSurveyId(req) {
  const explicit = req.query.s || req.body?.survey_id;
  if (!explicit) return null; // No survey ID = reject (no silent fallback)
  const id = Number(explicit);
  if (isNaN(id)) return null;
  const survey = await db.getSurveyById(id);
  return (survey && !!Number(survey.active)) ? id : null;
}

// --- Public API ---

const LONG_ANSWER_PATTERNS = ['réplique de film'];

app.get('/api/questions/next', async (req, res) => {
  try {
    const surveyId = await resolveSurveyId(req);
    if (!surveyId) {
      console.warn('No active survey found for params:', { s: req.query.s, survey_id: req.body?.survey_id });
      return res.json({ done: true });
    }
    let ex; try { ex = JSON.parse(req.query.exclude || '[]'); if (!Array.isArray(ex)) ex = []; } catch { ex = []; }
    const gender = req.query.gender || null;
    const age = req.query.age ? Number(req.query.age) : null;
    const q = await db.getAvailableQuestion(surveyId, ex, gender, age);
    if (!q) {
      console.warn('No available question for survey', surveyId, { gender, age, excludeCount: ex.length });
      return res.json({ done: true });
    }
    const isLong = LONG_ANSWER_PATTERNS.some(p => q.text.toLowerCase().includes(p));
    const cleanText = q.text.replace(/^\[V2\]\s*/, '');
    res.json({ id: q.id, text: cleanText, club: q.club, maxLength: isLong ? 200 : 40 });
  } catch (e) { console.error('GET /api/questions/next error:', e); res.status(500).json({ error: 'Erreur: ' + e.message }); }
});

app.post('/api/answers', rateLimit, async (req, res) => {
  try {
    const { question_id, text, response_time, gender, age, respondent_id } = req.body;
    if (!question_id || !text || typeof text !== 'string')
      return res.status(400).json({ error: 'Invalide' });

    const surveyId = await resolveSurveyId(req);
    if (!surveyId) return res.status(400).json({ error: 'Aucun sondage actif' });

    await refreshCache();

    const question = await db.getQuestionById(question_id);
    const isLong = question && LONG_ANSWER_PATTERNS.some(p => question.text.toLowerCase().includes(p));
    const maxLen = isLong ? 200 : 40;

    let normalized = normalizeAnswer(text);
    if (!normalized || normalized.length < 2 || normalized.length > maxLen) {
      await db.incrementRejected(surveyId, question_id);
      return res.status(400).json({ error: normalized && normalized.length > maxLen ? 'Réponse trop longue (max ' + maxLen + ' caractères)' : 'Donne une vraie réponse 😉', troll: true });
    }
    const rt = (typeof response_time === 'number' && response_time > 0 && response_time <= 45) ? Math.round(response_time) : null;
    if (isGibberish(normalized) || containsBannedWord(normalized)) {
      await db.incrementRejected(surveyId, question_id);
      return res.status(400).json({ error: 'Donne une vraie réponse 😉', troll: true });
    }

    // No auto-corrections — keep raw normalized answer

    // Validate and pass demographics
    const validGender = (gender === 'homme' || gender === 'femme') ? gender : null;
    const validAge = (typeof age === 'number' && age >= 10 && age <= 77) ? age : null;

    // Check gender quota for adults (minors always pass)
    if (validGender && validAge && validAge >= 18) {
      const genderCount = await db.getGenderAdultCount(surveyId, question_id, validGender);
      if (genderCount >= db.GENDER_QUOTA)
        return res.status(410).json({ error: 'Complet' });
    }

    // Auto-merge disabled — store raw answer as-is
    // Validate respondent_id format (should be a UUID-like string)
    const rid = (typeof respondent_id === 'string' && respondent_id.length >= 10 && respondent_id.length <= 50) ? respondent_id : null;
    await db.insertAnswer(surveyId, question_id, normalized, rt, validGender, validAge, rid);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/questions/:id/skip', rateLimit, async (req, res) => {
  try {
    const allowSkip = await db.getSetting('allow_skip');
    if (allowSkip === '0') return res.status(403).json({ error: 'Skip désactivé' });
    const surveyId = await resolveSurveyId(req);
    if (!surveyId) return res.status(400).json({ error: 'Aucun sondage actif' });
    await db.incrementSkip(surveyId, req.params.id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.get('/api/settings/allow-skip', async (req, res) => {
  try {
    const val = await db.getSetting('allow_skip');
    res.json({ enabled: val !== '0' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.get('/api/stats/participants', async (req, res) => {
  try {
    const surveyId = await resolveSurveyId(req);
    res.json({ count: surveyId ? await db.getTotalParticipantCount(surveyId) : 0 });
  } catch (e) { console.error('GET /api/stats/participants error:', e); res.status(500).json({ error: 'Erreur: ' + e.message }); }
});

// --- SSE for shooting mode ---
const sseClients = new Set();
function sendSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(msg);
    client.flush && client.flush();
  }
}

// --- Admin Auth ---

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) { req.session.isAdmin = true; return res.json({ ok: true }); }
  res.status(401).json({ error: 'Mot de passe incorrect' });
});
app.get('/api/admin/check', (req, res) => { res.json({ authenticated: !!req.session?.isAdmin }); });
app.post('/api/admin/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

// --- Admin: Survey management ---

app.get('/api/admin/surveys', requireAdmin, async (req, res) => {
  try { res.json(await db.getAllSurveys()); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/admin/surveys', requireAdmin, async (req, res) => {
  try {
    const { name, duplicate_from } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' });
    const r = await db.createSurvey(name.trim());
    const newId = r.lastInsertRowid;
    if (duplicate_from) {
      await db.duplicateQuestionsToSurvey(duplicate_from, newId);
    }
    res.json({ id: newId, name: name.trim() });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.put('/api/admin/surveys/:id', requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' });
    await db.renameSurvey(req.params.id, name.trim());
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/admin/surveys/:id/activate', requireAdmin, async (req, res) => {
  try {
    await db.activateSurvey(req.params.id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/admin/surveys/:id/deactivate', requireAdmin, async (req, res) => {
  try {
    await db.deactivateSurvey(req.params.id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.delete('/api/admin/surveys/:id', requireAdmin, async (req, res) => {
  try {
    const surveys = await db.getAllSurveys();
    if (surveys.length <= 1) return res.status(400).json({ error: 'Impossible de supprimer le dernier sondage' });
    await db.deleteSurvey(req.params.id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

// Update survey slug
app.put('/api/admin/surveys/:id/slug', requireAdmin, async (req, res) => {
  try {
    const slug = (req.body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (slug && slug.length < 2) return res.status(400).json({ error: 'Slug trop court (min 2 caractères)' });
    // Check uniqueness
    if (slug) {
      const existing = await db.getSurveyBySlug(slug);
      if (existing && existing.id !== Number(req.params.id)) return res.status(400).json({ error: 'Ce slug est déjà utilisé' });
    }
    await db.updateSurveySlug(req.params.id, slug || null);
    res.json({ ok: true, slug: slug || null });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

// Reset demographics for respondents (bumps demo_version)
app.post('/api/admin/surveys/:id/reset-demo', requireAdmin, async (req, res) => {
  try {
    await db.bumpDemoVersion(req.params.id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

// Public: get survey info (demo_version) for a survey
app.get('/api/survey-info', async (req, res) => {
  try {
    const slug = req.query.slug;
    const id = req.query.s;
    let survey = null;
    if (slug) survey = await db.getSurveyBySlug(slug);
    else if (id) {
      const all = await db.getAllSurveys();
      survey = all.find(s => s.id === Number(id));
    }
    if (!survey) return res.json({ error: 'not_found' });
    res.json({ id: survey.id, demo_version: survey.demo_version || 1 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add/remove questions from a survey
app.post('/api/admin/surveys/:id/questions', requireAdmin, async (req, res) => {
  try {
    const { question_id } = req.body;
    await db.addQuestionToSurvey(req.params.id, question_id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.delete('/api/admin/surveys/:surveyId/questions/:questionId', requireAdmin, async (req, res) => {
  try {
    await db.removeQuestionFromSurvey(req.params.surveyId, req.params.questionId);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

// --- Admin API (survey-scoped) ---

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const surveyId = req.query.survey_id;
    if (!surveyId) return res.json({ totalAnswers: 0, completeQuestions: 0, totalQuestions: 0, genderQuota: db.GENDER_QUOTA });
    res.json(await db.getStats(Number(surveyId)));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
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

app.put('/api/admin/categories/:id', requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' });
    await db.updateCategory(req.params.id, name.trim());
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.get('/api/admin/questions', requireAdmin, async (req, res) => {
  try {
    const surveyId = req.query.survey_id;
    if (!surveyId) return res.json([]);
    res.json(await db.getQuestionsWithCounts(Number(surveyId)));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/admin/questions', requireAdmin, async (req, res) => {
  try {
    const { category_id, text, survey_id } = req.body;
    if (!category_id || !text?.trim()) return res.status(400).json({ error: 'Requis' });
    const r = await db.insertQuestion(category_id, text.trim());
    // Auto-add to the specified survey
    if (survey_id) {
      await db.addQuestionToSurvey(survey_id, r.lastInsertRowid);
    }
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
    const surveyId = req.query.survey_id;
    const filter = req.query.filter; // 'representative' or undefined
    if (!surveyId) return res.status(400).json({ error: 'survey_id requis' });
    const question = await db.getQuestionById(req.params.id);
    if (!question) return res.status(404).json({ error: 'Introuvable' });
    let rawAnswers;
    if (filter === 'representative') {
      rawAnswers = await db.getAnswersGroupedRepresentative(Number(surveyId), req.params.id, db.GENDER_QUOTA);
    } else {
      rawAnswers = await db.getAnswersGrouped(Number(surveyId), req.params.id);
    }

    // Fuzzy-cluster similar answers for display
    const clustered = [];
    for (const item of rawAnswers) {
      let merged = false;
      for (const cluster of clustered) {
        if (areSimilar(item.normalized, cluster.normalized)) {
          cluster.count += item.count;
          cluster.variants.push(item.normalized);
          if (item.count > cluster.maxCount) {
            cluster.normalized = item.normalized;
            cluster.sample_text = item.sample_text;
            cluster.maxCount = item.count;
          }
          merged = true;
          break;
        }
      }
      if (!merged) {
        clustered.push({
          normalized: item.normalized,
          sample_text: item.sample_text,
          count: item.count,
          maxCount: item.count,
          variants: [item.normalized]
        });
      }
    }
    const answers = clustered
      .sort((a, b) => b.count - a.count)
      .map(c => ({ normalized: c.normalized, sample_text: c.sample_text, count: c.count, variants: c.variants }));

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
    const { question_id, answer_texts, canonical_text, survey_id } = req.body;
    if (!question_id || !answer_texts?.length || !canonical_text || !survey_id)
      return res.status(400).json({ error: 'Invalide' });
    await db.mergeAnswers(Number(survey_id), question_id, answer_texts, canonical_text.trim());
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

app.get('/api/admin/settings/video-mode', requireAdmin, async (req, res) => {
  try {
    const val = await db.getSetting('video_mode');
    res.json({ enabled: val === '1' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.put('/api/admin/settings/video-mode', requireAdmin, async (req, res) => {
  try {
    const { enabled } = req.body;
    await db.setSetting('video_mode', enabled ? '1' : '0');
    res.json({ ok: true, enabled: !!enabled });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.get('/api/admin/settings/allow-skip', requireAdmin, async (req, res) => {
  try {
    const val = await db.getSetting('allow_skip');
    res.json({ enabled: val !== '0' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.put('/api/admin/settings/allow-skip', requireAdmin, async (req, res) => {
  try {
    const { enabled } = req.body;
    await db.setSetting('allow_skip', enabled ? '1' : '0');
    res.json({ ok: true, enabled: !!enabled });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.get('/api/admin/export', requireAdmin, async (req, res) => {
  try {
    const surveyId = req.query.survey_id;
    if (!surveyId) return res.status(400).json({ error: 'survey_id requis' });
    const filter = req.query.filter;
    const rows = filter === 'representative'
      ? await db.getAllAnswersForExportRepresentative(Number(surveyId))
      : await db.getAllAnswersForExport(Number(surveyId));
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

app.get('/api/admin/questions/:id/export', requireAdmin, async (req, res) => {
  try {
    const surveyId = req.query.survey_id;
    if (!surveyId) return res.status(400).json({ error: 'survey_id requis' });
    const question = await db.getQuestionById(req.params.id);
    if (!question) return res.status(404).json({ error: 'Introuvable' });
    const filter = req.query.filter;
    const rawAnswers = filter === 'representative'
      ? await db.getAnswersGroupedRepresentative(Number(surveyId), req.params.id, db.GENDER_QUOTA)
      : await db.getAnswersGrouped(Number(surveyId), req.params.id);

    const clustered = [];
    for (const item of rawAnswers) {
      let merged = false;
      for (const cluster of clustered) {
        if (areSimilar(item.normalized, cluster.normalized)) {
          cluster.count += item.count;
          if (item.count > cluster.maxCount) {
            cluster.normalized = item.normalized;
            cluster.sample_text = item.sample_text;
            cluster.maxCount = item.count;
          }
          merged = true;
          break;
        }
      }
      if (!merged) {
        clustered.push({ normalized: item.normalized, sample_text: item.sample_text, count: item.count, maxCount: item.count });
      }
    }
    clustered.sort((a, b) => b.count - a.count);
    const total = clustered.reduce((s, a) => s + a.count, 0);

    const e = s => '"' + String(s).replace(/"/g, '""') + '"';
    let csv = '\uFEFFrang,réponse,count,pourcentage\n';
    clustered.forEach((a, i) => {
      const p = total > 0 ? ((a.count / total) * 100).toFixed(1) : '0.0';
      csv += `${i + 1},${e(a.sample_text)},${a.count},${p}%\n`;
    });

    const safeName = question.text.replace(/[^a-zA-Zà-ÿ0-9 ]/g, '').substring(0, 40).trim().replace(/\s+/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Q${req.params.id}_${safeName}.csv"`);
    res.send(csv);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/admin/reset', requireAdmin, async (req, res) => {
  try {
    const { survey_id } = req.body;
    if (!survey_id) return res.status(400).json({ error: 'survey_id requis' });
    await db.deleteAllAnswersForSurvey(Number(survey_id));
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });

// --- Shooting mode (Tournage) ---

app.get('/api/tournage/events', requireAdmin, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Content-Encoding': 'none',
  });
  res.write(':\n\n');
  res.flush && res.flush();
  sseClients.add(res);
  const keepalive = setInterval(() => { res.write(':\n\n'); res.flush && res.flush(); }, 15000);
  req.on('close', () => { clearInterval(keepalive); sseClients.delete(res); });
});

// --- Tournage API ---

app.get('/api/tournage/categories', requireAdmin, async (req, res) => {
  try { res.json(await db.getAllCategories()); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.get('/api/tournage/categories/:id/questions', requireAdmin, async (req, res) => {
  try { res.json(await db.getTournageQuestions(req.params.id)); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.get('/api/tournage/questions/:id', requireAdmin, async (req, res) => {
  try {
    const q = await db.getTournageQuestion(req.params.id);
    if (!q) return res.status(404).json({ error: 'Introuvable' });
    const answers = await db.getTournageAnswers(q.id);
    res.json({ question: q, answers });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.put('/api/tournage/questions/:id', requireAdmin, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Nom requis' });
    await db.renameTournageQuestion(req.params.id, text.trim());
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.delete('/api/tournage/questions/:id', requireAdmin, async (req, res) => {
  try {
    await db.deleteTournageQuestion(req.params.id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/tournage/reorder', requireAdmin, async (req, res) => {
  try {
    const { ordered_ids } = req.body;
    if (!Array.isArray(ordered_ids)) return res.status(400).json({ error: 'ordered_ids requis' });
    await db.reorderTournageQuestions(ordered_ids);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur' }); }
});

// CSV import for a tournage question
app.post('/api/tournage/import', requireAdmin, express.text({ type: '*/*', limit: '5mb' }), async (req, res) => {
  try {
    const { csv, category_id, rescale, replace_tq_id, custom_name } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!csv || !category_id) return res.status(400).json({ error: 'CSV et category_id requis' });

    const lines = csv.split('\n').map(l => l.trim()).filter(l => l);
    if (lines.length < 2) return res.status(400).json({ error: 'CSV vide ou invalide' });

    const header = lines[0].toLowerCase();
    const startIdx = (header.includes('question') || header.includes('réponse') || header.includes('reponse') || header.includes('count') || header.includes('club')) ? 1 : 0;

    let questionText = null;
    const answerRows = [];

    for (let i = startIdx; i < lines.length; i++) {
      const cols = [];
      let current = '', inQuotes = false;
      for (let j = 0; j < lines[i].length; j++) {
        const ch = lines[i][j];
        if (ch === '"') { inQuotes = !inQuotes; }
        else if ((ch === ',' || ch === ';') && !inQuotes) { cols.push(current.trim()); current = ''; }
        else { current += ch; }
      }
      cols.push(current.trim());

      if (cols.length < 4) continue;

      let qText, ansText, countVal, pctVal;
      if (cols.length >= 6) {
        qText = cols[2]; ansText = cols[3]; countVal = cols[4]; pctVal = cols[5];
      } else if (cols.length >= 4) {
        qText = cols[0]; ansText = cols[1]; countVal = cols[2]; pctVal = cols[3];
      } else continue;

      if (!questionText && qText) questionText = qText.replace(/^["']|["']$/g, '');
      const text = ansText.replace(/^["']|["']$/g, '').trim();
      const count = parseInt(countVal) || 0;
      const pct = parseFloat(pctVal.replace('%', '').replace(',', '.')) || 0;
      if (text && count > 0) answerRows.push({ text, count, pct });
    }

    if (custom_name) questionText = custom_name;
    if (!questionText || answerRows.length === 0) return res.status(400).json({ error: 'Aucune donnée valide trouvée dans le CSV' });

    if (rescale) {
      const totalCount = answerRows.reduce((s, a) => s + a.count, 0);
      if (totalCount > 0) {
        answerRows.forEach(a => {
          a.pct = (a.count / totalCount) * 100;
          a.count = Math.round((a.count / totalCount) * 100);
        });
      }
    }

    answerRows.sort((a, b) => b.count - a.count);

    let tqId;
    if (replace_tq_id) {
      tqId = replace_tq_id;
      await db.clearTournageAnswers(tqId);
    } else {
      const result = await db.insertTournageQuestion(category_id, questionText);
      tqId = result.lastInsertRowid;
    }

    for (const a of answerRows) {
      await db.insertTournageAnswer(tqId, a.text, a.count, a.pct);
    }

    res.json({ ok: true, tq_id: tqId, question: questionText, answer_count: answerRows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur import: ' + e.message }); }
});

// SSE events for display
app.post('/api/tournage/show-answer', requireAdmin, (req, res) => {
  const { answer, score } = req.body;
  sendSSE({ type: 'show-answer', answer, score });
  res.json({ ok: true });
});

app.post('/api/tournage/reveal-score', requireAdmin, (req, res) => {
  sendSSE({ type: 'reveal-score' });
  res.json({ ok: true });
});

app.post('/api/tournage/hors-panel', requireAdmin, (req, res) => {
  sendSSE({ type: 'hors-panel' });
  res.json({ ok: true });
});

app.post('/api/tournage/reset', requireAdmin, (req, res) => {
  sendSSE({ type: 'reset' });
  res.json({ ok: true });
});

app.post('/api/tournage/set-club', requireAdmin, (req, res) => {
  const { club } = req.body;
  sendSSE({ type: 'set-club', club });
  res.json({ ok: true });
});

app.get('/tournage', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'tournage.html')); });
app.get('/tournage/display', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'tournage-display.html')); });

// Slug route: /:slug serves the survey — must be LAST to not shadow other routes
app.get('/:slug', async (req, res, next) => {
  // Skip if it looks like a file request or known route
  if (req.params.slug.includes('.') || ['admin', 'tournage', 'health'].includes(req.params.slug)) return next();
  const survey = await db.getSurveyBySlug(req.params.slug);
  if (!survey) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

db.init().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server: http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin`);
  });
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
