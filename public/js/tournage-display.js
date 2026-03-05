(function () {
  const $ = id => document.getElementById(id);
  let eventSource = null;
  let currentScore = 0;
  let autoRevealTimer = null;

  // Auth check
  async function checkAuth() {
    const res = await fetch('/api/admin/check');
    const data = await res.json();
    if (data.authenticated) {
      $('login-overlay').classList.add('hidden');
      connectSSE();
    } else {
      $('login-overlay').classList.remove('hidden');
    }
  }

  async function login() {
    const pw = $('display-pw').value;
    const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
    if (res.ok) {
      $('login-overlay').classList.add('hidden');
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
    eventSource.onopen = () => {
      console.log('SSE connected');
      $('display-club').textContent = '🎬 Connecté — en attente';
      $('display-club').style.display = '';
    };
    eventSource.onmessage = (e) => {
      try {
        if (e.data.startsWith(':')) return; // keepalive comment
        const data = JSON.parse(e.data);
        handleEvent(data);
      } catch {}
    };
    eventSource.onerror = () => {
      console.log('SSE error, reconnecting...');
      // EventSource auto-reconnects
    };
  }

  function handleEvent(data) {
    switch (data.type) {
      case 'set-club':
        resetDisplay();
        const CLUBS = {
          'Le Glouton Club': '🍔 Le Glouton Club',
          'Metronomus': '🎵 Metronomus',
          'Red carpet': '🎬 Red carpet',
          'La situation': '💬 La situation'
        };
        $('display-club').textContent = CLUBS[data.club] || data.club;
        $('display-club').style.display = '';
        break;

      case 'show-answer':
        clearAutoReveal();
        $('display-hors-panel').style.display = 'none';
        $('display-score').style.display = 'none';
        currentScore = data.score;

        const answerEl = $('display-answer');
        const textEl = $('display-answer-text');
        textEl.textContent = data.answer.toUpperCase();
        answerEl.style.display = 'flex';
        answerEl.classList.remove('animate-in');
        void answerEl.offsetWidth; // force reflow
        answerEl.classList.add('animate-in');

        // Auto-reveal score after 3 seconds
        autoRevealTimer = setTimeout(() => revealScore(), 3000);
        break;

      case 'reveal-score':
        clearAutoReveal();
        revealScore();
        break;

      case 'hors-panel':
        clearAutoReveal();
        $('display-answer').style.display = 'none';
        $('display-score').style.display = 'none';

        const hpEl = $('display-hors-panel');
        hpEl.style.display = 'flex';
        hpEl.classList.remove('animate-shake');
        void hpEl.offsetWidth;
        hpEl.classList.add('animate-shake');
        break;

      case 'reset':
        resetDisplay();
        break;
    }
  }

  function revealScore() {
    const scoreEl = $('display-score');
    const numEl = $('display-score-num');
    numEl.textContent = currentScore;

    // Color based on score
    numEl.className = 'display-score-num';
    if (currentScore <= 5) numEl.classList.add('score-green');
    else if (currentScore <= 15) numEl.classList.add('score-orange');
    else numEl.classList.add('score-red');

    scoreEl.style.display = 'flex';
    scoreEl.classList.remove('animate-pop');
    void scoreEl.offsetWidth;
    scoreEl.classList.add('animate-pop');
  }

  function clearAutoReveal() {
    if (autoRevealTimer) { clearTimeout(autoRevealTimer); autoRevealTimer = null; }
  }

  function resetDisplay() {
    clearAutoReveal();
    $('display-answer').style.display = 'none';
    $('display-score').style.display = 'none';
    $('display-hors-panel').style.display = 'none';
  }

  checkAuth();
})();
