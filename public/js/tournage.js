(function () {
  const $ = id => document.getElementById(id);
  const CLUBS = {
    'Le Glouton Club': { emoji: '🍔', color: '#F5A623' },
    'Metronomus': { emoji: '🎵', color: '#7B68EE' },
    'Red carpet': { emoji: '🎬', color: '#E94560' },
    'La situation': { emoji: '💬', color: '#22C55E' }
  };

  let categories = [];
  let currentAnswers = [];
  let selectedAnswer = null;

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

  function renderClubs() {
    const container = $('club-selector');
    container.innerHTML = '';
    categories.forEach(cat => {
      const club = CLUBS[cat.name] || { emoji: '📋', color: '#888' };
      const btn = document.createElement('button');
      btn.className = 'club-btn';
      btn.style.borderColor = club.color;
      btn.innerHTML = '<span class="club-btn-emoji">' + club.emoji + '</span><span>' + cat.name + '</span>';
      btn.onclick = () => selectClub(cat);
      container.appendChild(btn);
    });
  }

  async function selectClub(cat) {
    const club = CLUBS[cat.name] || { emoji: '📋', color: '#888' };
    // Highlight selected
    document.querySelectorAll('.club-btn').forEach(b => b.classList.remove('active'));
    event.currentTarget.classList.add('active');

    // Send club name to display
    await api('/api/tournage/set-club', { method: 'POST', body: JSON.stringify({ club: cat.name }) });

    // Load questions
    const res = await api('/api/tournage/categories/' + cat.id + '/questions');
    const questions = await res.json();
    const sel = $('question-select');
    sel.innerHTML = '<option value="">Choisir une question...</option>';
    questions.forEach(q => {
      const opt = document.createElement('option');
      opt.value = q.id;
      opt.textContent = q.text + ' (' + q.answer_count + ' rép.)';
      sel.appendChild(opt);
    });
    $('question-section').style.display = '';
    $('answers-section').style.display = 'none';
    $('control-actions').style.display = 'none';
  }

  $('question-select').onchange = async function () {
    const qid = this.value;
    if (!qid) { $('answers-section').style.display = 'none'; return; }
    const res = await api('/api/tournage/questions/' + qid + '/answers');
    const data = await res.json();
    currentAnswers = data.answers;
    renderAnswers();
    $('answers-section').style.display = '';
    $('control-actions').style.display = 'none';
    selectedAnswer = null;
  };

  function renderAnswers() {
    const grid = $('answers-grid');
    grid.innerHTML = '';
    currentAnswers.forEach((a, i) => {
      const btn = document.createElement('button');
      btn.className = 'answer-btn';
      const scoreColor = a.score <= 5 ? '#22C55E' : a.score <= 15 ? '#F59E0B' : '#E94560';
      btn.innerHTML = '<span class="answer-btn-rank">#' + (i + 1) + '</span>' +
        '<span class="answer-btn-text">' + escHTML(a.text) + '</span>' +
        '<span class="answer-btn-score" style="color:' + scoreColor + '">' + a.score + '</span>';
      btn.onclick = () => triggerAnswer(a);
      grid.appendChild(btn);
    });
  }

  function escHTML(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function triggerAnswer(a) {
    selectedAnswer = a;
    // Highlight
    document.querySelectorAll('.answer-btn').forEach(b => b.classList.remove('selected'));
    event.currentTarget.classList.add('selected');
    $('custom-answer-input').value = a.text;
    await api('/api/tournage/show-answer', { method: 'POST', body: JSON.stringify({ answer: a.text, score: a.score }) });
    $('custom-actions').style.display = '';
    $('control-actions').style.display = '';
  }

  // Custom answer input
  $('btn-custom-send').onclick = async () => {
    const text = $('custom-answer-input').value.trim();
    if (!text) return;
    // Find matching score from panel
    const match = currentAnswers.find(a => a.text.toLowerCase() === text.toLowerCase());
    const score = match ? match.score : null;
    selectedAnswer = { text, score };
    document.querySelectorAll('.answer-btn').forEach(b => b.classList.remove('selected'));
    await api('/api/tournage/show-answer', { method: 'POST', body: JSON.stringify({ answer: text, score: score }) });
    $('custom-actions').style.display = '';
    $('control-actions').style.display = '';
  };

  $('custom-answer-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-custom-send').click(); });

  $('btn-custom-reveal').onclick = async () => {
    if (selectedAnswer && selectedAnswer.score != null) {
      await api('/api/tournage/reveal-score', { method: 'POST', body: JSON.stringify({}) });
    } else {
      // No score found - trigger hors panel
      await api('/api/tournage/hors-panel', { method: 'POST', body: JSON.stringify({}) });
    }
  };

  $('btn-hors-panel').onclick = async () => {
    selectedAnswer = null;
    document.querySelectorAll('.answer-btn').forEach(b => b.classList.remove('selected'));
    await api('/api/tournage/hors-panel', { method: 'POST', body: JSON.stringify({}) });
    $('custom-actions').style.display = '';
    $('control-actions').style.display = '';
  };

  $('btn-reveal').onclick = async () => {
    await api('/api/tournage/reveal-score', { method: 'POST', body: JSON.stringify({}) });
  };

  $('btn-reset-display').onclick = async () => {
    selectedAnswer = null;
    $('custom-answer-input').value = '';
    document.querySelectorAll('.answer-btn').forEach(b => b.classList.remove('selected'));
    await api('/api/tournage/reset', { method: 'POST', body: JSON.stringify({}) });
    $('custom-actions').style.display = 'none';
    $('control-actions').style.display = 'none';
  };

  checkAuth();
})();
