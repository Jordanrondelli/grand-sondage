(function () {
  const CLUBS = {
    'Le Glouton Club': { emoji: '🍔', color: '#F5A623' },
    'Metronomus':      { emoji: '🎵', color: '#7B68EE' },
    'Red carpet':      { emoji: '🎬', color: '#E94560' },
    'La situation':    { emoji: '💬', color: '#22C55E' },
  };

  const $ = id => document.getElementById(id);
  let categories = [], questions = [], bannedWords = [], corrections = [], surveys = [];
  let activeFilter = null, editorClub = null, expandedId = null, autoMerge = true, videoMode = false, allowSkip = true, searchQuery = '';
  let currentSurveyId = null; // the survey being viewed in admin
  let representativeMode = false;

  function show(id) { $('screen-login').classList.remove('active'); $('screen-dashboard').classList.remove('active'); $(id).classList.add('active'); }
  function vCount(n) { return videoMode ? Math.round(n / 10) : n; }
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  async function api(url, opts) {
    const res = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...opts?.headers } });
    if (res.status === 401) { show('screen-login'); throw new Error('unauth'); }
    return res;
  }

  // Auth
  async function checkAuth() {
    const r = await fetch('/api/admin/check'); const d = await r.json();
    if (d.authenticated) { show('screen-dashboard'); loadSurveys(); } else show('screen-login');
  }
  $('btn-login').onclick = async () => {
    const pw = $('login-pw').value;
    const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
    if (r.ok) { show('screen-dashboard'); loadSurveys(); }
    else { $('login-err').textContent = 'Incorrect'; setTimeout(() => $('login-err').textContent = '', 1500); }
  };
  $('login-pw').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-login').click(); });

  // --- Survey management ---

  async function loadSurveys() {
    try {
      const r = await api('/api/admin/surveys');
      surveys = await r.json();
      if (!currentSurveyId && surveys.length) {
        currentSurveyId = surveys[0].id;
      }
      renderSurveyTabs();
      loadAll();
    } catch (e) { if (e.message !== 'unauth') console.error(e); }
  }

  function renderSurveyTabs() {
    const c = $('survey-tabs'); c.innerHTML = '';
    surveys.forEach(s => {
      const tab = document.createElement('div');
      tab.className = 'survey-tab' + (currentSurveyId === s.id ? ' active' : '') + (s.active ? ' is-active-survey' : '');
      let html = '';
      if (s.active) html += '<span class="survey-active-dot" title="Sondage actif (lien accessible)"></span>';
      html += '<span>' + esc(s.name) + '</span>';
      html += '<span class="survey-tab-actions">';
      html += '<button class="survey-toggle-btn" title="' + (s.active ? 'Désactiver' : 'Activer') + ' ce sondage">' + (s.active ? '🔴' : '📡') + '</button>';
      html += '<button class="survey-rename-btn" title="Renommer">✏️</button>';
      if (surveys.length > 1) html += '<button class="survey-delete-btn" title="Supprimer">🗑️</button>';
      html += '</span>';
      tab.innerHTML = html;

      tab.addEventListener('click', (e) => {
        if (e.target.closest('.survey-tab-actions')) return;
        currentSurveyId = s.id;
        expandedId = null;
        renderSurveyTabs();
        loadAll();
      });

      tab.querySelector('.survey-toggle-btn').onclick = async (e) => {
        e.stopPropagation();
        const endpoint = s.active ? '/api/admin/surveys/' + s.id + '/deactivate' : '/api/admin/surveys/' + s.id + '/activate';
        await api(endpoint, { method: 'POST' });
        await loadSurveys();
      };

      tab.querySelector('.survey-rename-btn').onclick = (e) => {
        e.stopPropagation();
        const newName = prompt('Nouveau nom :', s.name);
        if (newName && newName.trim() && newName.trim() !== s.name) {
          api('/api/admin/surveys/' + s.id, { method: 'PUT', body: JSON.stringify({ name: newName.trim() }) })
            .then(() => loadSurveys());
        }
      };

      const deleteBtn = tab.querySelector('.survey-delete-btn');
      if (deleteBtn) {
        deleteBtn.onclick = async (e) => {
          e.stopPropagation();
          if (s.active && !confirm('Ce sondage est actif ! Supprimer quand même "' + s.name + '" et toutes ses réponses ?')) return;
          if (!s.active && !confirm('Supprimer le sondage "' + s.name + '" et toutes ses réponses ?')) return;
          await api('/api/admin/surveys/' + s.id, { method: 'DELETE' });
          if (currentSurveyId === s.id) currentSurveyId = null;
          await loadSurveys();
        };
      }

      c.appendChild(tab);
    });

    // Show survey URL below tabs
    let urlBox = $('survey-url-box');
    if (!urlBox) {
      urlBox = document.createElement('div');
      urlBox.id = 'survey-url-box';
      urlBox.className = 'survey-url-box';
      $('survey-bar').parentNode.insertBefore(urlBox, $('survey-bar').nextSibling);
    }
    const currentSurvey = surveys.find(s => s.id === currentSurveyId);
    if (currentSurvey) {
      const base = window.location.origin;
      const surveySlug = currentSurvey.slug;
      const url = surveySlug ? base + '/' + surveySlug : base + '/?s=' + currentSurvey.id;
      const statusHtml = currentSurvey.active
        ? '<span class="survey-url-status on">ACTIF</span>'
        : '<span class="survey-url-status off">INACTIF</span>';
      urlBox.innerHTML = '<span class="survey-url-label">🔗 Lien du sondage "<strong>' + esc(currentSurvey.name) + '</strong>" ' + statusHtml + '</span>' +
        '<div class="survey-url-row">' +
          '<input class="survey-url-input" id="survey-url-input" value="' + url + '" readonly>' +
          '<button class="survey-url-copy" id="survey-url-copy" title="Copier">📋</button>' +
        '</div>' +
        '<div class="survey-slug-row" style="margin-top:8px;display:flex;align-items:center;gap:6px">' +
          '<label style="font-size:0.85em;color:#aaa">Slug :</label>' +
          '<span style="font-size:0.85em;color:#666">' + base + '/</span>' +
          '<input class="survey-slug-input" id="survey-slug-input" value="' + (surveySlug || '') + '" placeholder="mon-sondage" style="flex:1;padding:6px 10px;border-radius:8px;border:1px solid #333;background:#1a1a2e;color:#fff;font-size:0.9em">' +
          '<button class="btn-slug-save" id="btn-slug-save" style="padding:6px 12px;border-radius:8px;background:#6366f1;color:#fff;border:none;cursor:pointer;font-size:0.85em">Enregistrer</button>' +
        '</div>' +
        '<div class="survey-actions-row" style="margin-top:10px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap"></div>';

      $('survey-url-copy').onclick = () => {
        navigator.clipboard.writeText(url).then(() => {
          $('survey-url-copy').textContent = '✅';
          setTimeout(() => { $('survey-url-copy').textContent = '📋'; }, 1500);
        });
      };
      $('survey-url-input').onclick = () => { $('survey-url-input').select(); };

      // Save slug
      $('btn-slug-save').onclick = async () => {
        const newSlug = $('survey-slug-input').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
        const r = await api('/api/admin/surveys/' + currentSurvey.id + '/slug', { method: 'PUT', body: JSON.stringify({ slug: newSlug }) });
        if (r.ok) {
          $('btn-slug-save').textContent = '✅';
          setTimeout(() => { $('btn-slug-save').textContent = 'Enregistrer'; }, 1500);
          await loadSurveys();
        } else {
          const err = await r.json().catch(() => ({}));
          alert(err.error || 'Erreur');
        }
      };

      // Action buttons container
      const actionsRow = urlBox.querySelector('.survey-actions-row');

      // Activate/deactivate button
      if (currentSurvey.active) {
        actionsRow.innerHTML = '<button class="btn-survey-toggle btn-survey-deactivate">🔴 Désactiver ce sondage</button>';
      } else {
        actionsRow.innerHTML = '<button class="btn-survey-toggle btn-survey-activate">🟢 Activer ce sondage</button>';
      }
      actionsRow.querySelector('.btn-survey-toggle').onclick = async () => {
        const endpoint = currentSurvey.active
          ? '/api/admin/surveys/' + currentSurvey.id + '/deactivate'
          : '/api/admin/surveys/' + currentSurvey.id + '/activate';
        await api(endpoint, { method: 'POST' });
        await loadSurveys();
      };

      // Reset demographics button
      const resetDemoBtn = document.createElement('button');
      resetDemoBtn.textContent = '🔄 Réinitialiser les données démographiques';
      resetDemoBtn.style.cssText = 'padding:8px 16px;border-radius:8px;background:#ef4444;color:#fff;border:none;cursor:pointer;font-size:0.85em';
      resetDemoBtn.onclick = async () => {
        if (!confirm('Les répondants devront re-saisir leur genre et âge au prochain chargement. Continuer ?')) return;
        await api('/api/admin/surveys/' + currentSurvey.id + '/reset-demo', { method: 'POST' });
        resetDemoBtn.textContent = '✅ Réinitialisé !';
        setTimeout(() => { resetDemoBtn.textContent = '🔄 Réinitialiser les données démographiques'; }, 2000);
      };
      actionsRow.appendChild(resetDemoBtn);
    } else {
      urlBox.innerHTML = '';
    }
  }

  $('btn-new-survey').onclick = async () => {
    const name = prompt('Nom du nouveau sondage :');
    if (!name || !name.trim()) return;
    let duplicateFrom = null;
    if (surveys.length > 0) {
      if (confirm('Dupliquer les questions du sondage actuel ("' + (surveys.find(s => s.id === currentSurveyId)?.name || '') + '") ?')) {
        duplicateFrom = currentSurveyId;
      }
    }
    const r = await api('/api/admin/surveys', { method: 'POST', body: JSON.stringify({ name: name.trim(), duplicate_from: duplicateFrom }) });
    const data = await r.json();
    currentSurveyId = data.id;
    await loadSurveys();
  };

  // --- Load all data for current survey ---

  async function loadAll() {
    if (!currentSurveyId) return;
    try {
      const [sr, qr, cr, br, corr, amr, vmr, asr] = await Promise.all([
        api('/api/admin/stats?survey_id=' + currentSurveyId),
        api('/api/admin/questions?survey_id=' + currentSurveyId),
        api('/api/admin/categories'),
        api('/api/admin/banned-words'), api('/api/admin/corrections'), api('/api/admin/settings/auto-merge'),
        api('/api/admin/settings/video-mode'), api('/api/admin/settings/allow-skip')
      ]);
      const stats = await sr.json(); questions = await qr.json(); categories = await cr.json();
      bannedWords = await br.json(); corrections = await corr.json();
      const amData = await amr.json(); autoMerge = amData.enabled;
      const vmData = await vmr.json(); videoMode = vmData.enabled;
      const asData = await asr.json(); allowSkip = asData.enabled;
      renderStats(stats);
      renderFilters();
      renderCards();
      if (!editorClub && categories.length) editorClub = categories[0].name;
      renderEditorTabs();
      renderEditor();
      renderBanned();
      renderCorrections();
      renderAutoMerge();
      renderVideoMode();
      renderAllowSkip();
    } catch (e) { if (e.message !== 'unauth') console.error('loadAll error:', e); }
  }

  // Search
  $('search-input').addEventListener('input', function() {
    searchQuery = this.value.toLowerCase().trim();
    renderCards();
  });

  // Stats
  let lastStats = null;
  const GENDER_QUOTA = 500;
  function renderStats(s) {
    if (s) lastStats = s; else s = lastStats;
    if (!s) return;
    $('s-total').textContent = vCount(representativeMode ? (s.adultMale || 0) + (s.adultFemale || 0) : s.totalAnswers);
    $('s-complete').textContent = s.completeQuestions + '/' + s.totalQuestions;
    const pct = s.totalQuestions > 0 ? Math.round((s.completeQuestions / s.totalQuestions) * 100) : 0;
    $('s-pct').textContent = pct + '%';
    $('s-pct').style.color = pct >= 100 ? '#22C55E' : '#F59E0B';
    // Demographics
    const gc = s.genderCounts || {};
    $('ds-hommes').textContent = '👨 ' + (s.adultMale || 0) + '/' + GENDER_QUOTA + ' hommes 18+ (total: ' + (gc.homme || 0) + ')';
    $('ds-femmes').textContent = '👩 ' + (s.adultFemale || 0) + '/' + GENDER_QUOTA + ' femmes 18+ (total: ' + (gc.femme || 0) + ')';
    $('ds-adults').textContent = '🎯 Objectif: ' + GENDER_QUOTA + 'H + ' + GENDER_QUOTA + 'F adultes par question';
    $('ds-minors').textContent = '👶 ' + (s.minorCount || 0) + ' mineurs (non comptés)';
    if (s.noDemoCount > 0) {
      $('ds-minors').textContent += '  |  ⚠️ ' + s.noDemoCount + ' réponses sans démographie (anciennes)';
    }
    // Age distribution
    renderAgePanel(s);
  }

  function renderAgePanel(s) {
    const panel = $('age-panel');
    const dist = s.ageDistribution || [];
    if (!dist.length) { panel.style.display = 'none'; return; }
    panel.style.display = '';

    // Average
    $('age-avg').textContent = 'Moyenne : ' + (s.avgAge || 0).toFixed(1) + ' ans';

    // Group by age brackets
    const brackets = [
      { label: '10-14', min: 10, max: 14 },
      { label: '15-17', min: 15, max: 17 },
      { label: '18-24', min: 18, max: 24 },
      { label: '25-34', min: 25, max: 34 },
      { label: '35-44', min: 35, max: 44 },
      { label: '45-54', min: 45, max: 54 },
      { label: '55-64', min: 55, max: 64 },
      { label: '65+', min: 65, max: 99 },
    ];
    const total = dist.reduce((a, r) => a + r.count, 0);
    const grouped = brackets.map(b => {
      const count = dist.filter(r => r.age >= b.min && r.age <= b.max).reduce((a, r) => a + r.count, 0);
      return { ...b, count, pct: total > 0 ? (count / total * 100) : 0 };
    }).filter(b => b.count > 0 || b.min >= 18); // always show 18+ brackets

    const maxPct = Math.max(...grouped.map(b => b.pct), 1);
    let html = '';
    grouped.forEach(b => {
      const barW = Math.max((b.pct / maxPct) * 100, 1);
      const isMinor = b.max < 18;
      html += '<div class="age-bar-row">' +
        '<span class="age-bar-label">' + b.label + '</span>' +
        '<div class="age-bar-track"><div class="age-bar-fill' + (isMinor ? ' minor' : '') + '" style="width:' + barW.toFixed(1) + '%"></div></div>' +
        '<span class="age-bar-val">' + b.count + ' <small>(' + b.pct.toFixed(1) + '%)</small></span>' +
      '</div>';
    });
    $('age-chart').innerHTML = html;

    // Footer: individual ages detail
    const topAges = dist.sort((a, b) => b.count - a.count).slice(0, 5);
    $('age-footer').textContent = 'Top âges : ' + topAges.map(r => r.age + ' ans (' + r.count + ')').join(', ');
  }

  // Representative mode toggle
  $('btn-representative').onclick = () => {
    representativeMode = !representativeMode;
    $('btn-representative').textContent = representativeMode ? 'ON' : 'OFF';
    $('btn-representative').className = 'toggle-btn ' + (representativeMode ? 'on' : 'off');
    renderStats();
    renderCards();
  };

  // Filters
  function renderFilters() {
    const c = $('filter-pills'); c.innerHTML = '';
    const all = document.createElement('button');
    all.className = 'pill' + (!activeFilter ? ' active' : '');
    all.textContent = 'Toutes';
    if (!activeFilter) all.style.cssText = 'background:#333;border-color:#333;color:#fff';
    all.onclick = () => { activeFilter = null; renderFilters(); renderCards(); };
    c.appendChild(all);
    // V2 filter
    const v2btn = document.createElement('button');
    v2btn.className = 'pill' + (activeFilter === '__v2__' ? ' active' : '');
    v2btn.textContent = '🔁 V2';
    if (activeFilter === '__v2__') v2btn.style.cssText = 'background:#E94560;border-color:#E94560;color:#fff';
    v2btn.onclick = () => { activeFilter = '__v2__'; renderFilters(); renderCards(); };
    c.appendChild(v2btn);
    categories.forEach(cat => {
      const b = document.createElement('button');
      const club = CLUBS[cat.name] || { emoji: '', color: '#888' };
      b.className = 'pill' + (activeFilter === cat.name ? ' active' : '');
      b.textContent = club.emoji + ' ' + cat.name;
      if (activeFilter === cat.name) b.style.cssText = 'background:' + club.color + ';border-color:' + club.color + ';color:#fff';
      b.onclick = () => { activeFilter = cat.name; renderFilters(); renderCards(); };
      c.appendChild(b);
    });
  }

  // Cards
  function renderCards() {
    const c = $('q-cards'); c.innerHTML = '';
    let filtered = activeFilter === '__v2__' ? questions.filter(q => q.text.startsWith('[V2]')) : activeFilter ? questions.filter(q => q.category_name === activeFilter) : questions;
    if (searchQuery) filtered = filtered.filter(q => q.text.toLowerCase().includes(searchQuery));
    filtered.forEach((q, idx) => {
      const club = CLUBS[q.category_name] || { emoji: '', color: '#888' };
      const card = document.createElement('div');
      card.className = 'q-card' + (expandedId === q.id ? ' open' : '');
      const maleOk = q.male_adult_count >= GENDER_QUOTA;
      const femaleOk = q.female_adult_count >= GENDER_QUOTA;
      const isComplete = maleOk && femaleOk;
      const rawCount = representativeMode ? (q.male_adult_count + q.female_adult_count) : q.answer_count;
      const displayCount = vCount(rawCount);
      const displayMax = videoMode ? 100 : 1000;
      const countColor = isComplete ? '#22C55E' : (maleOk || femaleOk) ? '#F59E0B' : '#888';
      const avgLabel = q.avg_time ? q.avg_time + 's' : '—';
      const skipLabel = q.skip_count > 0 ? q.skip_count : '0';
      const rejLabel = q.rejected_count > 0 ? ' · 🚫 ' + q.rejected_count + ' rejetée' + (q.rejected_count > 1 ? 's' : '') : '';
      const variantLabel = q.variant_group ? ' · 🔗 variante ' + q.variant_group : '';
      const maleColor = maleOk ? '#22C55E' : '#888';
      const femaleColor = femaleOk ? '#22C55E' : '#888';
      const dq = videoMode ? Math.round(GENDER_QUOTA / 10) : GENDER_QUOTA;
      const qNum = idx + 1;
      card.innerHTML =
        '<div class="q-card-header" data-qid="' + q.id + '">' +
          '<div class="q-card-left">' +
            '<div class="club-label"><span class="club-dot" style="background:' + club.color + '"></span>' + esc(q.category_name) + '</div>' +
            '<div class="q-card-text"><span class="q-num">' + qNum + '.</span> ' + esc(q.text) + '</div>' +
            '<div class="q-card-meta">⏱ ' + avgLabel + ' moy. · ⏭ ' + skipLabel + ' skip' + (q.skip_count > 1 ? 's' : '') + rejLabel + variantLabel + '</div>' +
          '</div>' +
          '<div class="q-card-right">' +
            '<div class="q-card-actions">' +
              '<button class="q-action-btn q-edit-btn" title="Modifier la question">✏️</button>' +
              '<button class="q-action-btn q-del-btn" title="Supprimer la question">🗑️</button>' +
            '</div>' +
            '<div class="q-card-count" style="color:' + countColor + '">' + displayCount + '<span style="color:#555;font-size:13px">/' + displayMax + '</span></div>' +
            '<div class="q-card-gender-counts">' +
              '<span style="color:' + maleColor + '">👨 ' + (videoMode ? Math.round(q.male_adult_count/10) : q.male_adult_count) + '/' + dq + '</span>' +
              '<span style="color:' + femaleColor + '">👩 ' + (videoMode ? Math.round(q.female_adult_count/10) : q.female_adult_count) + '/' + dq + '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="q-card-detail" id="detail-' + q.id + '"></div>';
      card.querySelector('.q-card-header').onclick = (e) => {
        if (e.target.closest('.q-action-btn')) return;
        toggleCard(q.id);
      };
      card.querySelector('.q-edit-btn').onclick = (e) => {
        e.stopPropagation();
        const newText = prompt('Modifier la question :', q.text);
        if (newText && newText.trim() && newText.trim() !== q.text) {
          api('/api/admin/questions/' + q.id, { method: 'PUT', body: JSON.stringify({ text: newText.trim(), category_id: q.category_id }) })
            .then(() => loadAll());
        }
      };
      card.querySelector('.q-del-btn').onclick = (e) => {
        e.stopPropagation();
        if (!confirm('Supprimer la question "' + q.text + '" et toutes ses réponses ?')) return;
        api('/api/admin/questions/' + q.id, { method: 'DELETE' }).then(() => {
          if (expandedId === q.id) expandedId = null;
          loadAll();
        });
      };
      c.appendChild(card);
    });
    if (expandedId) loadDetail(expandedId);
  }

  async function toggleCard(id) {
    if (expandedId === id) { expandedId = null; renderCards(); return; }
    expandedId = id;
    renderCards();
    await loadDetail(id);
  }

  async function loadDetail(id) {
    const filterParam = representativeMode ? '&filter=representative' : '';
    const r = await api('/api/admin/questions/' + id + '/answers?survey_id=' + currentSurveyId + filterParam);
    const data = await r.json();
    const det = $('detail-' + id);
    if (!det) return;
    const selectedSet = new Set();
    const ind = data.indicators || {};

    // --- 3 indicators + verdict ---
    const trapIcon = ind.trapClear ? '✅' : '⚠️';
    const trapText = ind.trapClear ? 'Piège clair (' + ind.top1Pct.toFixed(1) + '%)' : 'Pas de piège évident (' + (ind.top1Pct || 0).toFixed(1) + '%)';

    const stepsIcon = ind.stepsOk === 'good' ? '✅' : ind.stepsOk === 'mid' ? '⚠️' : '❌';
    const stepsText = ind.stepsOk === 'good' ? 'Descente progressive (' + ind.above2pct + ' paliers)'
      : ind.stepsOk === 'mid' ? 'Peu de paliers (' + ind.above2pct + ')'
      : 'Trou entre le piège et le vide (' + (ind.above2pct || 0) + ')';

    const riskIcon = ind.riskOk ? '✅' : '⚠️';
    const riskText = ind.riskOk ? 'Risque hors panel (top 5 = ' + data.top5Pct.toFixed(1) + '%)' : 'Presque impossible de se planter (top 5 = ' + data.top5Pct.toFixed(1) + '%)';

    let verdictClass, verdictText;
    if (ind.verdict === 'perfect') { verdictClass = 'verdict-green'; verdictText = '✅ Question parfaite'; }
    else if (ind.verdict === 'ok') { verdictClass = 'verdict-orange'; verdictText = '⚠️ Jouable mais pas idéale'; }
    else { verdictClass = 'verdict-red'; verdictText = '❌ Question à remplacer'; }

    let html = '<div class="indicators">' +
      '<div class="ind-row"><span class="ind-icon">' + trapIcon + '</span><span class="ind-text">' + trapText + '</span></div>' +
      '<div class="ind-row"><span class="ind-icon">' + stepsIcon + '</span><span class="ind-text">' + stepsText + '</span></div>' +
      '<div class="ind-row"><span class="ind-icon">' + riskIcon + '</span><span class="ind-text">' + riskText + '</span></div>' +
      '<div class="verdict ' + verdictClass + '">' + verdictText + '</div></div>';

    // Build variant map for merge
    const variantMap = {};
    html += '<div class="answer-list" id="alist-' + id + '">';
    data.answers.forEach((a, i) => {
      const barClass = a.percentage >= 10 ? 'bar-trap' : a.percentage >= 3 ? 'bar-smart' : 'bar-risky';
      const displayC = vCount(a.count);
      variantMap[a.normalized] = a.variants || [a.normalized];
      html += '<div class="answer-row-item" data-norm="' + esc(a.normalized) + '">' +
        '<div class="answer-cb" data-norm="' + esc(a.normalized) + '"></div>' +
        '<span class="answer-rank">' + (i + 1) + '</span>' +
        '<span class="answer-name">' + esc(a.sample_text) + '</span>' +
        '<button class="answer-edit-btn" title="Modifier">✏️</button>' +
        '<div class="answer-minibar"><div class="answer-minibar-fill ' + barClass + '" style="width:' + Math.min(a.percentage, 100) + '%"></div></div>' +
        '<span class="answer-stat">' + displayC + ' (' + a.percentage.toFixed(1) + '%)</span></div>';
    });
    html += '</div>';
    html += '<div class="merge-bar" id="merge-bar-' + id + '"><div class="merge-label" id="merge-label-' + id + '"></div><div class="merge-row"><input class="merge-input" id="merge-input-' + id + '"><button class="btn-merge" id="merge-go-' + id + '">Fusionner</button><button class="btn-merge-cancel" id="merge-cancel-' + id + '">Annuler</button></div></div>';
    html += '<div class="answer-footer"><button class="btn-export-q" id="export-q-' + id + '">Exporter CSV</button> ' + data.answers.length + ' réponses uniques — ' + vCount(data.totalCount) + ' au total — cliquer pour sélectionner et fusionner</div>';
    det.innerHTML = html;

    // Click handlers
    det.querySelectorAll('.answer-row-item').forEach(row => {
      row.onclick = () => {
        const norm = row.dataset.norm;
        const cb = row.querySelector('.answer-cb');
        if (selectedSet.has(norm)) { selectedSet.delete(norm); cb.classList.remove('checked'); cb.textContent = ''; }
        else { selectedSet.add(norm); cb.classList.add('checked'); cb.textContent = '✓'; }
        updateMerge();
      };
    });

    function updateMerge() {
      const bar = $('merge-bar-' + id);
      if (selectedSet.size >= 2) {
        bar.classList.add('visible');
        $('merge-label-' + id).textContent = 'Fusionner ' + selectedSet.size + ' réponses en :';
        const inp = $('merge-input-' + id);
        if (!inp.value) inp.value = [...selectedSet][0];
      } else {
        bar.classList.remove('visible');
      }
    }

    $('merge-go-' + id).onclick = async () => {
      const canonical = $('merge-input-' + id).value.trim();
      if (!canonical) return;
      const allTexts = new Set();
      for (const norm of selectedSet) {
        (variantMap[norm] || [norm]).forEach(v => allTexts.add(v));
      }
      await api('/api/admin/merge', { method: 'POST', body: JSON.stringify({ question_id: Number(id), answer_texts: [...allTexts], canonical_text: canonical, survey_id: currentSurveyId }) });
      selectedSet.clear();
      $('merge-input-' + id).value = '';
      await loadAll();
      expandedId = id;
      renderCards();
      loadDetail(id);
    };
    $('merge-cancel-' + id).onclick = () => {
      selectedSet.clear();
      det.querySelectorAll('.answer-cb').forEach(cb => { cb.classList.remove('checked'); cb.textContent = ''; });
      $('merge-bar-' + id).classList.remove('visible');
      $('merge-input-' + id).value = '';
    };

    // Per-question CSV export
    $('export-q-' + id).onclick = (e) => {
      e.stopPropagation();
      window.location.href = '/api/admin/questions/' + id + '/export?survey_id=' + currentSurveyId + (representativeMode ? '&filter=representative' : '');
    };

    // Answer editing
    det.querySelectorAll('.answer-edit-btn').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const row = btn.closest('.answer-row-item');
        const norm = row.dataset.norm;
        const nameEl = row.querySelector('.answer-name');
        const current = nameEl.textContent;
        const newVal = prompt('Corriger cette réponse :', current);
        if (newVal && newVal.trim() && newVal.trim() !== current) {
          api('/api/admin/merge', { method: 'POST', body: JSON.stringify({ question_id: Number(id), answer_texts: [norm], canonical_text: newVal.trim(), survey_id: currentSurveyId }) })
            .then(() => { loadAll(); expandedId = id; setTimeout(() => { renderCards(); loadDetail(id); }, 200); });
        }
      };
    });
  }

  // Editor
  $('btn-manage').onclick = () => {
    const ed = $('editor');
    ed.classList.toggle('hidden');
  };

  function renderEditorTabs() {
    const c = $('club-tabs'); c.innerHTML = '';
    categories.forEach(cat => {
      const club = CLUBS[cat.name] || { emoji: '', color: '#888' };
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:inline-flex;align-items:center;gap:2px';
      const b = document.createElement('button');
      b.className = 'club-tab' + (editorClub === cat.name ? ' active' : '');
      b.textContent = club.emoji + ' ' + cat.name;
      if (editorClub === cat.name) b.style.cssText = 'background:' + club.color + ';border-color:' + club.color;
      b.onclick = () => { editorClub = cat.name; renderEditorTabs(); renderEditor(); };
      wrap.appendChild(b);
      if (editorClub === cat.name) {
        const editBtn = document.createElement('button');
        editBtn.className = 'club-edit-btn';
        editBtn.textContent = '✏️';
        editBtn.title = 'Renommer';
        editBtn.onclick = (e) => {
          e.stopPropagation();
          const newName = prompt('Nouveau nom pour "' + cat.name + '" :', cat.name);
          if (newName && newName.trim() && newName.trim() !== cat.name) {
            api('/api/admin/categories/' + cat.id, { method: 'PUT', body: JSON.stringify({ name: newName.trim() }) })
              .then(() => { editorClub = newName.trim(); loadAll(); });
          }
        };
        wrap.appendChild(editBtn);
      }
      c.appendChild(wrap);
    });
    const club = CLUBS[editorClub] || { color: '#888' };
    $('btn-add-q').style.background = club.color;
  }

  function renderEditor() {
    const list = $('editor-list'); list.innerHTML = '';
    const catObj = categories.find(c => c.name === editorClub);
    if (!catObj) return;
    const qs = questions.filter(q => q.category_id === catObj.id);
    qs.forEach((q, i) => {
      const item = document.createElement('div');
      item.className = 'editor-item';
      item.innerHTML = '<span class="num">' + (i + 1) + '.</span><span class="qtxt">' + esc(q.text) + '</span>' +
        '<button class="edit-btn" title="Modifier">✏️</button><button class="del-btn" title="Supprimer">🗑️</button>';
      // Edit
      item.querySelector('.edit-btn').onclick = () => {
        item.innerHTML = '<span class="num">' + (i + 1) + '.</span>' +
          '<input class="edit-input" value="' + esc(q.text) + '">' +
          '<button class="save-btn" style="color:#22C55E">✓</button><button class="cancel-btn" style="color:#888">✕</button>';
        item.querySelector('.save-btn').onclick = async () => {
          const val = item.querySelector('.edit-input').value.trim();
          if (!val) return;
          await api('/api/admin/questions/' + q.id, { method: 'PUT', body: JSON.stringify({ text: val, category_id: q.category_id }) });
          await loadAll();
        };
        item.querySelector('.cancel-btn').onclick = () => renderEditor();
        item.querySelector('.edit-input').focus();
      };
      // Delete
      item.querySelector('.del-btn').onclick = async () => {
        await api('/api/admin/questions/' + q.id, { method: 'DELETE' });
        await loadAll();
      };
      list.appendChild(item);
    });
  }

  async function addQuestion() {
    const val = $('add-input').value.trim();
    if (!val) { alert('Écris une question d\'abord'); return; }
    const catObj = categories.find(c => c.name === editorClub);
    if (!catObj) { alert('Erreur : aucun club sélectionné. Clique sur un onglet de club.'); return; }
    try {
      const r = await api('/api/admin/questions', { method: 'POST', body: JSON.stringify({ category_id: catObj.id, text: val, survey_id: currentSurveyId }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); alert('Erreur : ' + (d.error || r.status)); return; }
      $('add-input').value = '';
      await loadAll();
    } catch (e) { if (e.message !== 'unauth') alert('Erreur réseau : ' + e.message); }
  }
  $('btn-add-q').onclick = addQuestion;
  $('add-input').addEventListener('keydown', e => { if (e.key === 'Enter') addQuestion(); });

  // --- Auto-merge toggle ---
  function renderAutoMerge() {
    const btn = $('btn-auto-merge');
    btn.textContent = autoMerge ? 'Activé' : 'Désactivé';
    btn.className = 'toggle-btn ' + (autoMerge ? 'on' : 'off');
  }
  $('btn-auto-merge').onclick = async () => {
    autoMerge = !autoMerge;
    renderAutoMerge();
    await api('/api/admin/settings/auto-merge', { method: 'PUT', body: JSON.stringify({ enabled: autoMerge }) });
  };

  // --- Video Mode toggle ---
  function renderVideoMode() {
    const btn = $('btn-video-mode');
    btn.textContent = videoMode ? 'Activé' : 'Désactivé';
    btn.className = 'toggle-btn ' + (videoMode ? 'on' : 'off');
  }
  $('btn-video-mode').onclick = async () => {
    videoMode = !videoMode;
    renderVideoMode();
    renderStats();
    renderCards();
    await api('/api/admin/settings/video-mode', { method: 'PUT', body: JSON.stringify({ enabled: videoMode }) });
  };

  // --- Allow Skip toggle ---
  function renderAllowSkip() {
    const btn = $('btn-allow-skip');
    btn.textContent = allowSkip ? 'Activé' : 'Désactivé';
    btn.className = 'toggle-btn ' + (allowSkip ? 'on' : 'off');
  }
  $('btn-allow-skip').onclick = async () => {
    allowSkip = !allowSkip;
    renderAllowSkip();
    await api('/api/admin/settings/allow-skip', { method: 'PUT', body: JSON.stringify({ enabled: allowSkip }) });
  };

  // --- Banned Words ---
  $('btn-banned').onclick = () => { $('banned-section').classList.toggle('hidden'); };

  function renderBanned() {
    const c = $('banned-list'); c.innerHTML = '';
    bannedWords.forEach(bw => {
      const tag = document.createElement('span');
      tag.className = 'tag-item';
      tag.innerHTML = esc(bw.word) + '<button class="tag-del" title="Supprimer">✕</button>';
      tag.querySelector('.tag-del').onclick = async () => {
        await api('/api/admin/banned-words/' + bw.id, { method: 'DELETE' });
        await loadAll();
      };
      c.appendChild(tag);
    });
    if (!bannedWords.length) c.innerHTML = '<span style="font-size:12px;color:#555">Aucun mot banni</span>';
  }

  async function addBanned() {
    const val = $('banned-input').value.trim();
    if (!val) return;
    await api('/api/admin/banned-words', { method: 'POST', body: JSON.stringify({ word: val }) });
    $('banned-input').value = '';
    await loadAll();
  }
  $('btn-add-banned').onclick = addBanned;
  $('banned-input').addEventListener('keydown', e => { if (e.key === 'Enter') addBanned(); });

  // --- Corrections ---
  $('btn-corrections').onclick = () => { $('corrections-section').classList.toggle('hidden'); };

  function renderCorrections() {
    const c = $('corrections-list'); c.innerHTML = '';
    corrections.forEach(cr => {
      const item = document.createElement('div');
      item.className = 'corr-item';
      item.innerHTML = '<span class="corr-wrong">' + esc(cr.wrong) + '</span>' +
        '<span class="corr-arrow">→</span>' +
        '<span class="corr-right">' + esc(cr.correct) + '</span>' +
        '<button class="corr-del" title="Supprimer">✕</button>';
      item.querySelector('.corr-del').onclick = async () => {
        await api('/api/admin/corrections/' + cr.id, { method: 'DELETE' });
        await loadAll();
      };
      c.appendChild(item);
    });
    if (!corrections.length) c.innerHTML = '<span style="font-size:12px;color:#555">Aucune correction</span>';
  }

  async function addCorrection() {
    const wrong = $('correction-wrong').value.trim();
    const right = $('correction-right').value.trim();
    if (!wrong || !right) return;
    await api('/api/admin/corrections', { method: 'POST', body: JSON.stringify({ wrong: wrong, correct: right }) });
    $('correction-wrong').value = '';
    $('correction-right').value = '';
    await loadAll();
  }
  $('btn-add-correction').onclick = addCorrection;
  $('correction-right').addEventListener('keydown', e => { if (e.key === 'Enter') addCorrection(); });

  // Export
  $('btn-export').onclick = () => { window.location.href = '/api/admin/export?survey_id=' + currentSurveyId + (representativeMode ? '&filter=representative' : ''); };
  // Tournage
  $('btn-tournage').onclick = () => { window.open('/tournage', '_blank'); };

  // Reset
  $('btn-reset').onclick = () => { $('confirm-reset').style.display = ''; };
  $('reset-no').onclick = () => { $('confirm-reset').style.display = 'none'; };
  $('reset-yes').onclick = async () => {
    await api('/api/admin/reset', { method: 'POST', body: JSON.stringify({ survey_id: currentSurveyId }) });
    $('confirm-reset').style.display = 'none';
    expandedId = null;
    await loadAll();
  };

  checkAuth();
})();
