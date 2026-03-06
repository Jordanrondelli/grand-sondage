(function () {
  const $ = id => document.getElementById(id);
  let eventSource = null;
  let currentScore = 0;
  let currentAnswer = '';

  // Auth
  async function checkAuth() {
    const res = await fetch('/api/admin/check');
    const data = await res.json();
    if (data.authenticated) {
      $('login-overlay').classList.add('hidden');
      connectSSE();
    } else {
      $('login-overlay').classList.remove('hidden');
      $('login-overlay').style.display = 'flex';
    }
  }

  async function login() {
    const pw = $('display-pw').value;
    const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
    if (res.ok) {
      $('login-overlay').classList.add('hidden');
      $('login-overlay').style.display = 'none';
      connectSSE();
    } else {
      $('display-err').textContent = 'Mot de passe incorrect';
    }
  }

  $('display-login-btn').onclick = login;
  $('display-pw').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });

  function connectSSE() {
    if (eventSource) { eventSource.close(); eventSource = null; }
    eventSource = new EventSource('/api/tournage/events');
    eventSource.onmessage = (e) => {
      try {
        if (e.data.startsWith(':')) return;
        handleEvent(JSON.parse(e.data));
      } catch {}
    };
    eventSource.onerror = () => { /* auto-reconnects */ };
  }

  function handleEvent(data) {
    switch (data.type) {
      case 'set-club':
        resetDisplay();
        break;

      case 'show-answer':
        resetDisplay();
        currentAnswer = data.answer || '';
        currentScore = data.score;
        showAnswer(currentAnswer);
        break;

      case 'reveal-score':
        revealScore();
        break;

      case 'hors-panel':
        showHorsPanel();
        break;

      case 'reset':
        resetDisplay();
        break;
    }
  }

  function showAnswer(text) {
    const el = $('display-answer');
    const textEl = $('display-answer-text');
    textEl.textContent = text.toUpperCase();

    // Dynamic font size based on length
    const len = text.length;
    let fontSize = 82;
    if (len > 30) fontSize = 52;
    else if (len > 15) fontSize = 68;
    textEl.style.fontSize = fontSize + 'px';

    // Show with animation
    el.classList.remove('visible');
    void el.offsetWidth;
    el.classList.add('visible');
  }

  function revealScore() {
    if (currentScore == null) return;
    const wrap = $('display-score-wrap');
    const numEl = $('display-score-num');
    const badge = $('display-badge');
    const ring = $('display-ring');

    numEl.textContent = currentScore;

    // Color
    let color, glowColor, badgeText, badgeClass;
    if (currentScore <= 5) {
      color = '#4ADE80'; glowColor = 'rgba(74,222,128,.4)'; badgeText = 'EXCELLENT'; badgeClass = 'badge-green';
    } else if (currentScore <= 15) {
      color = '#FBBF24'; glowColor = 'rgba(251,191,36,.4)'; badgeText = 'CORRECT'; badgeClass = 'badge-orange';
    } else {
      color = '#F87171'; glowColor = 'rgba(248,113,113,.4)'; badgeText = 'RISQUÉ'; badgeClass = 'badge-red';
    }

    numEl.style.color = color;
    wrap.style.setProperty('--score-glow', glowColor);
    badge.textContent = badgeText;
    badge.className = 'display-badge ' + badgeClass;

    // Ring burst
    ring.style.borderColor = color;
    ring.classList.remove('burst');
    void ring.offsetWidth;
    ring.classList.add('burst');

    // Move answer up slightly
    const ansEl = $('display-answer');
    ansEl.style.transform = 'translateY(-20px)';

    // Show score
    wrap.classList.remove('visible');
    void wrap.offsetWidth;
    wrap.classList.add('visible');
  }

  function showHorsPanel() {
    // Hide score wrap if visible
    $('display-score-wrap').classList.remove('visible');
    $('display-answer').classList.remove('visible');

    const hp = $('display-hp-wrap');
    $('display-hp-answer').textContent = currentAnswer.toUpperCase() || '';

    hp.classList.remove('visible');
    void hp.offsetWidth;
    hp.classList.add('visible');

    // Red vignette
    $('display-vignette').classList.add('visible');
  }

  function resetDisplay() {
    $('display-answer').classList.remove('visible');
    $('display-answer').style.transform = '';
    $('display-score-wrap').classList.remove('visible');
    $('display-hp-wrap').classList.remove('visible');
    $('display-vignette').classList.remove('visible');
    $('display-ring').classList.remove('burst');
    currentAnswer = '';
    currentScore = 0;
  }

  checkAuth();
})();
