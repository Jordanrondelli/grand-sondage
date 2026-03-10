(function () {
  const $ = id => document.getElementById(id);
  const CLUBS = {
    'Le Glouton Club': { emoji: '🍔', color: '#F5A623' },
    'Metronomus': { emoji: '🎵', color: '#7B68EE' },
    'Red carpet': { emoji: '🎬', color: '#E94560' },
    'La situation': { emoji: '💬', color: '#22C55E' }
  };

  let categories = [];
  let currentCatId = null;
  let currentTqId = null;
  let currentAnswers = [];
  let selectedAnswer = null;
  let pendingCsv = null;
  let pendingReplaceTqId = null;

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  async function api(url, opts) {
    const res = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) } });
    if (res.status === 401) { location.reload(); return; }
    return res;
  }

  // Auth
  async function checkAuth() {
    const res = await fetch('/api/admin/check');
    const data = await res.json();
    if (data.authenticated) showControl();
  }

  async function login() {
    const pw = $('login-pw').value;
    const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
    if (res.ok) showControl();
    else $('login-err').textContent = 'Mot de passe incorrect';
  }

  $('btn-login').onclick = login;
  $('login-pw').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });

  async function showControl() {
    $('screen-login').style.display = 'none';
    $('screen-control').style.display = 'flex';
    const res = await api('/api/tournage/categories');
    categories = await res.json();
    renderClubs();
  }

  // --- Clubs ---
  function renderClubs() {
    const c = $('club-selector');
    c.innerHTML = '';
    categories.forEach(cat => {
      const club = CLUBS[cat.name] || { emoji: '📋', color: '#888' };
      const btn = document.createElement('button');
      btn.className = 'club-btn' + (currentCatId === cat.id ? ' active' : '');
      if (currentCatId === cat.id) btn.style.borderColor = club.color;
      btn.innerHTML = '<span class="club-btn-emoji">' + club.emoji + '</span><span>' + esc(cat.name) + '</span>';
      btn.onclick = () => selectClub(cat);
      c.appendChild(btn);
    });
  }

  async function selectClub(cat) {
    currentCatId = cat.id;
    currentTqId = null;
    renderClubs();
    await api('/api/tournage/set-club', { method: 'POST', body: JSON.stringify({ club: cat.name }) });
    await loadQuestions();
    $('questions-section').style.display = '';
    $('answer-section').style.display = 'none';
  }

  // --- Questions list ---
  async function loadQuestions() {
    const res = await api('/api/tournage/categories/' + currentCatId + '/questions');
    const questions = await res.json();
    renderQuestionList(questions);
  }

  function renderQuestionList(questions) {
    const list = $('tq-list');
    list.innerHTML = '';
    if (questions.length === 0) {
      list.innerHTML = '<div class="tq-empty">Aucune question importée. Importez un CSV.</div>';
      return;
    }
    questions.forEach((q, i) => {
      const item = document.createElement('div');
      item.className = 'tq-item' + (currentTqId === q.id ? ' active' : '');
      item.innerHTML =
        '<div class="tq-arrows">' +
          '<button class="tq-arrow-up' + (i === 0 ? ' disabled' : '') + '" title="Monter">▲</button>' +
          '<button class="tq-arrow-down' + (i === questions.length - 1 ? ' disabled' : '') + '" title="Descendre">▼</button>' +
        '</div>' +
        '<span class="tq-num">' + (i + 1) + '</span>' +
        '<span class="tq-text">' + esc(q.text) + '</span>' +
        '<span class="tq-count">' + q.answer_count + ' rép.</span>' +
        '<button class="tq-rename" title="Renommer">✏️</button>' +
        '<button class="tq-reimport" title="Réimporter CSV">🔄</button>' +
        '<button class="tq-delete" title="Supprimer">🗑️</button>';
      item.querySelector('.tq-text').onclick = () => selectQuestion(q.id);
      item.querySelector('.tq-num').onclick = () => selectQuestion(q.id);
      item.querySelector('.tq-arrow-up').onclick = (e) => { e.stopPropagation(); moveQuestion(questions, i, -1); };
      item.querySelector('.tq-arrow-down').onclick = (e) => { e.stopPropagation(); moveQuestion(questions, i, 1); };
      item.querySelector('.tq-rename').onclick = (e) => { e.stopPropagation(); renameQuestion(q.id, q.text); };
      item.querySelector('.tq-reimport').onclick = (e) => { e.stopPropagation(); startReimport(q.id); };
      item.querySelector('.tq-delete').onclick = (e) => { e.stopPropagation(); deleteQuestion(q.id, q.text); };
      list.appendChild(item);
    });
  }

  async function moveQuestion(questions, index, direction) {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= questions.length) return;
    const ids = questions.map(q => q.id);
    const tmp = ids[index];
    ids[index] = ids[newIndex];
    ids[newIndex] = tmp;
    await api('/api/tournage/reorder', { method: 'POST', body: JSON.stringify({ ordered_ids: ids }) });
    await loadQuestions();
  }

  async function selectQuestion(tqId) {
    currentTqId = tqId;
    const res = await api('/api/tournage/questions/' + tqId);
    const data = await res.json();
    currentAnswers = data.answers;
    $('selected-q-label').textContent = data.question.text;
    $('custom-answer-input').value = '';
    selectedAnswer = null;
    $('action-buttons').style.display = 'none';
    renderAnswerGrid();
    $('answer-section').style.display = '';
    await loadQuestions(); // refresh active state
  }

  function renderAnswerGrid() {
    const grid = $('answers-grid');
    grid.innerHTML = '';
    currentAnswers.forEach((a, i) => {
      const scoreColor = a.percentage <= 5 ? '#4ADE80' : a.percentage <= 15 ? '#FBBF24' : '#F87171';
      const btn = document.createElement('button');
      btn.className = 'answer-btn';
      btn.innerHTML =
        '<span class="answer-btn-rank">#' + (i + 1) + '</span>' +
        '<span class="answer-btn-text">' + esc(a.text) + '</span>' +
        '<span class="answer-btn-score" style="color:' + scoreColor + '">' + a.count + '</span>';
      btn.onclick = () => triggerPanelAnswer(a, btn);
      grid.appendChild(btn);
    });
  }

  // --- Trigger answer from panel click ---
  function triggerPanelAnswer(a, btnEl) {
    selectedAnswer = { text: a.text, score: a.count };
    document.querySelectorAll('.answer-btn').forEach(b => b.classList.remove('selected'));
    btnEl.classList.add('selected');
    $('custom-answer-input').value = a.text;
    api('/api/tournage/show-answer', { method: 'POST', body: JSON.stringify({ answer: a.text, score: a.count }) });
    $('action-buttons').style.display = '';
  }

  // --- Custom answer input ---
  function findMatchInPanel(text) {
    const t = text.toLowerCase().trim();
    if (!t) return null;
    // Exact match first
    let match = currentAnswers.find(a => a.text.toLowerCase() === t);
    if (match) return match;
    // Then check if typed text contains a panel answer or vice-versa
    match = currentAnswers.find(a => {
      const at = a.text.toLowerCase();
      return at.includes(t) || t.includes(at);
    });
    return match || null;
  }

  $('btn-show-answer').onclick = () => {
    const text = $('custom-answer-input').value.trim();
    if (!text) return;
    const match = findMatchInPanel(text);
    selectedAnswer = match ? { text: text, score: match.count } : { text, score: null };
    document.querySelectorAll('.answer-btn').forEach(b => b.classList.remove('selected'));
    if (match) {
      const idx = currentAnswers.indexOf(match);
      const btns = document.querySelectorAll('.answer-btn');
      if (btns[idx]) btns[idx].classList.add('selected');
    }
    api('/api/tournage/show-answer', { method: 'POST', body: JSON.stringify({ answer: text, score: selectedAnswer.score }) });
    $('action-buttons').style.display = '';
  };

  $('custom-answer-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-show-answer').click(); });

  // --- Reveal / Hors panel / Reset ---
  $('btn-reveal-score').onclick = () => {
    if (selectedAnswer && selectedAnswer.score != null) {
      api('/api/tournage/reveal-score', { method: 'POST', body: JSON.stringify({}) });
    } else {
      api('/api/tournage/hors-panel', { method: 'POST', body: JSON.stringify({}) });
    }
  };

  $('btn-hors-panel').onclick = () => {
    api('/api/tournage/hors-panel', { method: 'POST', body: JSON.stringify({}) });
  };

  $('btn-reset-display').onclick = () => {
    selectedAnswer = null;
    $('custom-answer-input').value = '';
    document.querySelectorAll('.answer-btn').forEach(b => b.classList.remove('selected'));
    api('/api/tournage/reset', { method: 'POST', body: JSON.stringify({}) });
    $('action-buttons').style.display = 'none';
  };

  // --- CSV Import ---
  $('btn-import-csv').onclick = () => {
    pendingReplaceTqId = null;
    $('csv-file-input').click();
  };

  function startReimport(tqId) {
    pendingReplaceTqId = tqId;
    $('csv-file-input').click();
  }

  $('csv-file-input').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      pendingCsv = ev.target.result;
      // Pre-fill name with filename without extension
      const baseName = file.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ');
      $('modal-name-input').value = baseName;
      $('modal-info').textContent = 'Fichier : ' + file.name + ' (' + Math.round(file.size / 1024) + ' Ko)';
      $('import-modal').style.display = '';
    };
    reader.readAsText(file, 'UTF-8');
    e.target.value = '';
  };

  $('btn-import-asis').onclick = () => doImport(false);
  $('btn-import-rescale').onclick = () => doImport(true);
  $('btn-import-cancel').onclick = () => { $('import-modal').style.display = 'none'; pendingCsv = null; };

  async function doImport(rescale) {
    $('import-modal').style.display = 'none';
    if (!pendingCsv || !currentCatId) return;
    const customName = $('modal-name-input').value.trim();
    const body = { csv: pendingCsv, category_id: currentCatId, rescale, custom_name: customName || null };
    if (pendingReplaceTqId) {
      if (!confirm('Cela va écraser les réponses existantes. Continuer ?')) return;
      body.replace_tq_id = pendingReplaceTqId;
    }
    const res = await api('/api/tournage/import', { method: 'POST', body: JSON.stringify(body) });
    const data = await res.json();
    if (data.ok) {
      await loadQuestions();
      if (data.tq_id) await selectQuestion(data.tq_id);
    } else {
      alert('Erreur: ' + (data.error || 'Import échoué'));
    }
    pendingCsv = null;
    pendingReplaceTqId = null;
  }

  async function renameQuestion(tqId, currentText) {
    const newName = prompt('Renommer la question :', currentText);
    if (newName && newName.trim() && newName.trim() !== currentText) {
      await api('/api/tournage/questions/' + tqId, { method: 'PUT', body: JSON.stringify({ text: newName.trim() }) });
      await loadQuestions();
      if (currentTqId === tqId) $('selected-q-label').textContent = newName.trim();
    }
  }

  async function deleteQuestion(tqId, text) {
    if (!confirm('Supprimer "' + text + '" ?')) return;
    await api('/api/tournage/questions/' + tqId, { method: 'DELETE' });
    if (currentTqId === tqId) {
      currentTqId = null;
      $('answer-section').style.display = 'none';
    }
    await loadQuestions();
  }

  checkAuth();
})();
