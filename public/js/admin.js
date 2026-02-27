(function () {
  const CLUBS = {
    'vacances':    { emoji: '🏖️', color: '#E94560' },
    'nourriture':  { emoji: '🍔', color: '#F5A623' },
    'cinéma':      { emoji: '🎬', color: '#7B68EE' },
  };

  const $ = id => document.getElementById(id);
  let categories = [], questions = [], bannedWords = [], corrections = [];
  let activeFilter = null, editorClub = null, expandedId = null, autoMerge = true;

  function show(id) { $('screen-login').classList.remove('active'); $('screen-dashboard').classList.remove('active'); $(id).classList.add('active'); }
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  async function api(url, opts) {
    const res = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...opts?.headers } });
    if (res.status === 401) { show('screen-login'); throw new Error('unauth'); }
    return res;
  }

  // Auth
  async function checkAuth() {
    const r = await fetch('/api/admin/check'); const d = await r.json();
    if (d.authenticated) { show('screen-dashboard'); loadAll(); } else show('screen-login');
  }
  $('btn-login').onclick = async () => {
    const pw = $('login-pw').value;
    const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
    if (r.ok) { show('screen-dashboard'); loadAll(); }
    else { $('login-err').textContent = 'Incorrect'; setTimeout(() => $('login-err').textContent = '', 1500); }
  };
  $('login-pw').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-login').click(); });

  // Load
  async function loadAll() {
    try {
      const [sr, qr, cr, br, corr, amr] = await Promise.all([
        api('/api/admin/stats'), api('/api/admin/questions'), api('/api/admin/categories'),
        api('/api/admin/banned-words'), api('/api/admin/corrections'), api('/api/admin/settings/auto-merge')
      ]);
      const stats = await sr.json(); questions = await qr.json(); categories = await cr.json();
      bannedWords = await br.json(); corrections = await corr.json();
      const amData = await amr.json(); autoMerge = amData.enabled;
      renderStats(stats);
      renderFilters();
      renderCards();
      if (!editorClub && categories.length) editorClub = categories[0].name;
      renderEditorTabs();
      renderEditor();
      renderBanned();
      renderCorrections();
      renderAutoMerge();
    } catch (e) { if (e.message !== 'unauth') console.error('loadAll error:', e); }
  }

  // Stats
  function renderStats(s) {
    $('s-total').textContent = s.totalAnswers;
    $('s-complete').textContent = s.completeQuestions + '/' + s.totalQuestions;
    const pct = s.totalQuestions > 0 ? Math.round((s.completeQuestions / s.totalQuestions) * 100) : 0;
    $('s-pct').textContent = pct + '%';
    $('s-pct').style.color = pct >= 100 ? '#22C55E' : '#F59E0B';
  }

  // Filters
  function renderFilters() {
    const c = $('filter-pills'); c.innerHTML = '';
    const all = document.createElement('button');
    all.className = 'pill' + (!activeFilter ? ' active' : '');
    all.textContent = 'Toutes';
    if (!activeFilter) all.style.cssText = 'background:#333;border-color:#333;color:#fff';
    all.onclick = () => { activeFilter = null; renderFilters(); renderCards(); };
    c.appendChild(all);
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
    const filtered = activeFilter ? questions.filter(q => q.category_name === activeFilter) : questions;
    filtered.forEach(q => {
      const club = CLUBS[q.category_name] || { emoji: '', color: '#888' };
      const card = document.createElement('div');
      card.className = 'q-card' + (expandedId === q.id ? ' open' : '');
      const countColor = q.answer_count >= 100 ? '#22C55E' : q.answer_count > 50 ? '#F59E0B' : '#888';
      const avgLabel = q.avg_time ? q.avg_time + 's' : '—';
      const skipLabel = q.skip_count > 0 ? q.skip_count : '0';
      const rejLabel = q.rejected_count > 0 ? ' · 🚫 ' + q.rejected_count + ' rejetée' + (q.rejected_count > 1 ? 's' : '') : '';
      card.innerHTML =
        '<div class="q-card-header" data-qid="' + q.id + '">' +
          '<div class="q-card-left">' +
            '<div class="club-label"><span class="club-dot" style="background:' + club.color + '"></span>' + esc(q.category_name) + '</div>' +
            '<div class="q-card-text">' + esc(q.text) + '</div>' +
            '<div class="q-card-meta">⏱ ' + avgLabel + ' moy. · ⏭ ' + skipLabel + ' skip' + (q.skip_count > 1 ? 's' : '') + rejLabel + '</div>' +
          '</div>' +
          '<div class="q-card-count" style="color:' + countColor + '">' + q.answer_count + '<span style="color:#555;font-size:13px">/100</span></div>' +
        '</div>' +
        '<div class="q-card-detail" id="detail-' + q.id + '"></div>';
      card.querySelector('.q-card-header').onclick = () => toggleCard(q.id);
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
    const r = await api('/api/admin/questions/' + id + '/answers');
    const data = await r.json();
    const det = $('detail-' + id);
    if (!det) return;
    const selectedSet = new Set();

    // Top 5
    let t5color = '#888', t5label = '';
    if (data.top5Status === 'good') { t5color = '#22C55E'; t5label = '✅ Bon profil'; }
    else if (data.top5Status === 'concentrated') { t5color = '#EF4444'; t5label = '⚠️ Trop concentré'; }
    else if (data.top5Status === 'scattered') { t5color = '#F59E0B'; t5label = '⚠️ Trop éclaté'; }

    let html = '<div class="top5-bar">' +
      '<div class="top5-text" style="color:' + t5color + '">Top 5 = ' + data.top5Pct.toFixed(1) + '%</div>' +
      '<div class="top5-track"><div class="top5-fill" style="width:' + Math.min(data.top5Pct, 100) + '%;background:' + t5color + '"></div></div>' +
      '<div class="top5-verdict" style="color:' + t5color + '">' + t5label + '</div></div>';

    html += '<div class="answer-list" id="alist-' + id + '">';
    data.answers.forEach((a, i) => {
      const isTop = i < 5;
      html += '<div class="answer-row-item' + (isTop ? ' top5' : '') + '" data-norm="' + esc(a.normalized) + '">' +
        '<div class="answer-cb" data-norm="' + esc(a.normalized) + '"></div>' +
        '<span class="answer-rank">' + (i + 1) + '</span>' +
        '<span class="answer-name">' + esc(a.sample_text) + '</span>' +
        '<div class="answer-minibar"><div class="answer-minibar-fill ' + (isTop ? 'top' : 'rest') + '" style="width:' + Math.min(a.percentage, 100) + '%"></div></div>' +
        '<span class="answer-stat">' + a.count + ' (' + a.percentage.toFixed(1) + '%)</span></div>';
    });
    html += '</div>';
    html += '<div class="merge-bar" id="merge-bar-' + id + '"><div class="merge-label" id="merge-label-' + id + '"></div><div class="merge-row"><input class="merge-input" id="merge-input-' + id + '"><button class="btn-merge" id="merge-go-' + id + '">Fusionner</button><button class="btn-merge-cancel" id="merge-cancel-' + id + '">Annuler</button></div></div>';
    html += '<div class="answer-footer">' + data.answers.length + ' réponses uniques — cliquer pour sélectionner et fusionner</div>';
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
      await api('/api/admin/merge', { method: 'POST', body: JSON.stringify({ question_id: Number(id), answer_texts: [...selectedSet], canonical_text: canonical }) });
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
      const b = document.createElement('button');
      b.className = 'club-tab' + (editorClub === cat.name ? ' active' : '');
      b.textContent = club.emoji + ' ' + cat.name;
      if (editorClub === cat.name) b.style.cssText = 'background:' + club.color + ';border-color:' + club.color;
      b.onclick = () => { editorClub = cat.name; renderEditorTabs(); renderEditor(); };
      c.appendChild(b);
    });
    // Set add button color
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
      const r = await api('/api/admin/questions', { method: 'POST', body: JSON.stringify({ category_id: catObj.id, text: val }) });
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
  $('btn-export').onclick = () => { window.location.href = '/api/admin/export'; };

  // Reset
  $('btn-reset').onclick = () => { $('confirm-reset').style.display = ''; };
  $('reset-no').onclick = () => { $('confirm-reset').style.display = 'none'; };
  $('reset-yes').onclick = async () => {
    await api('/api/admin/reset', { method: 'POST' });
    $('confirm-reset').style.display = 'none';
    expandedId = null;
    await loadAll();
  };

  checkAuth();
})();
