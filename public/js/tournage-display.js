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
      $('login-overlay').style.display = 'none';
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
    eventSource.onerror = () => {};
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

    // Dynamic font size
    const len = text.length;
    let fontSize = 90;
    if (len > 30) fontSize = 52;
    else if (len > 15) fontSize = 68;
    textEl.style.fontSize = fontSize + 'px';

    // Smooth fade in
    el.classList.add('visible');
  }

  function revealScore() {
    if (currentScore == null) return;
    const wrap = $('display-score-wrap');
    const numEl = $('display-score-num');

    numEl.textContent = currentScore;

    // Color: green (low count) → orange → red (high count)
    let color, glowColor;
    if (currentScore <= 5) {
      color = '#4ADE80'; glowColor = 'rgba(74,222,128,.4)';
    } else if (currentScore <= 15) {
      color = '#FBBF24'; glowColor = 'rgba(251,191,36,.4)';
    } else {
      color = '#F87171'; glowColor = 'rgba(248,113,113,.4)';
    }

    numEl.style.color = color;
    wrap.style.setProperty('--score-glow', glowColor);

    // Show with scale pop
    wrap.classList.remove('visible');
    void wrap.offsetWidth;
    wrap.classList.add('visible');
  }

  function showHorsPanel() {
    // Keep the answer visible — don't hide it
    // Hide score if it was shown
    $('display-score-wrap').classList.remove('visible');

    // Show cross overlay with shake
    const overlay = $('display-hp-overlay');
    const cross = $('display-hp-cross');
    overlay.classList.add('visible');
    cross.classList.remove('shake');
    void cross.offsetWidth;
    cross.classList.add('shake');

    // Red vignette
    $('display-vignette').classList.add('visible');
  }

  function resetDisplay() {
    $('display-answer').classList.remove('visible');
    $('display-score-wrap').classList.remove('visible');
    $('display-hp-overlay').classList.remove('visible');
    $('display-hp-cross').classList.remove('shake');
    $('display-vignette').classList.remove('visible');
    currentAnswer = '';
    currentScore = 0;
  }

  checkAuth();
})();
