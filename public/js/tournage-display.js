(function () {
  const $ = id => document.getElementById(id);
  let eventSource = null;
  let currentScore = 0;
  let currentAnswer = '';
  let currentRank = null;
  let currentTotal = null;
  let typewriterTimer = null;
  let counterTimer = null;

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
        currentRank = data.rank || null;
        currentTotal = data.total || null;
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

  // --- TYPEWRITER ANSWER ---
  function showAnswer(text) {
    const el = $('display-answer');
    const textEl = $('display-answer-text');
    const upper = text.toUpperCase();

    // Dynamic font size
    const len = text.length;
    let fontSize = 96;
    if (len > 30) fontSize = 56;
    else if (len > 15) fontSize = 72;
    textEl.style.fontSize = fontSize + 'px';

    // Clear previous
    textEl.innerHTML = '';
    el.classList.add('visible');
    el.classList.remove('glitch', 'glitched');

    // Typewriter effect
    let i = 0;
    const cursor = document.createElement('span');
    cursor.className = 'tw-cursor';

    function typeNext() {
      if (i < upper.length) {
        // Remove cursor, add letter, re-add cursor
        if (cursor.parentNode) cursor.remove();
        const span = document.createElement('span');
        span.textContent = upper[i];
        span.style.opacity = '0';
        textEl.appendChild(span);
        textEl.appendChild(cursor);
        // Fade in the letter
        requestAnimationFrame(() => {
          span.style.transition = 'opacity .08s';
          span.style.opacity = '1';
        });
        i++;
        const speed = Math.max(25, 50 - len); // faster for longer text
        typewriterTimer = setTimeout(typeNext, speed);
      } else {
        // Done typing — remove cursor after a beat
        setTimeout(() => { if (cursor.parentNode) cursor.remove(); }, 600);
      }
    }
    typeNext();
  }

  // --- Rank-based color helper ---
  function getRankStyle(rank, total) {
    if (!rank || !total) return null;
    const ratio = rank / total;
    if (ratio <= 0.1) return { label: 'TOP !', color: '#FFD700', glow: 'rgba(255,215,0,.4)', tint: 'rgba(255,215,0,.06)', tier: 'gold' };
    if (ratio <= 0.3) return { label: 'Bien joué !', color: '#4ADE80', glow: 'rgba(74,222,128,.4)', tint: 'rgba(74,222,128,.06)', tier: 'green' };
    if (ratio <= 0.6) return { label: 'Correct', color: '#FBBF24', glow: 'rgba(251,191,36,.4)', tint: 'rgba(251,191,36,.06)', tier: 'yellow' };
    return { label: 'Rare...', color: '#F87171', glow: 'rgba(248,113,113,.4)', tint: 'rgba(248,113,113,.06)', tier: 'red' };
  }

  // --- ROLLING COUNTER SCORE ---
  function revealScore() {
    if (currentScore == null) return;
    clearInterval(counterTimer);

    const wrap = $('display-score-wrap');
    const numEl = $('display-score-num');
    const tint = $('display-tint');
    const target = currentScore;

    // Color based on rank position (not raw score)
    const style = getRankStyle(currentRank, currentTotal);
    let color, glowColor, tintColor;
    if (style) {
      color = style.color; glowColor = style.glow; tintColor = style.tint;
    } else {
      color = '#fff'; glowColor = 'rgba(255,255,255,.3)'; tintColor = 'rgba(255,255,255,.04)';
    }

    numEl.style.color = color;
    wrap.style.setProperty('--score-glow', glowColor);

    // Show wrap
    numEl.textContent = '0';
    wrap.classList.add('visible');

    // Rolling counter
    let current = 0;
    const duration = 1200;
    const steps = Math.min(target, 40);
    const stepTime = duration / Math.max(steps, 1);

    counterTimer = setInterval(() => {
      current++;
      const progress = current / steps;
      const eased = Math.round(target * (1 - Math.pow(1 - progress, 3)));
      numEl.textContent = Math.min(eased, target);

      if (current >= steps) {
        clearInterval(counterTimer);
        numEl.textContent = target;

        // Big pulse at the end
        wrap.classList.remove('pulse');
        void wrap.offsetWidth;
        wrap.classList.add('pulse');

        // Tint the background
        tint.style.background = 'radial-gradient(ellipse at center, ' + tintColor + ' 0%, transparent 70%)';
        tint.classList.add('visible');

        // Show rank after score reveal
        if (currentRank != null && currentTotal != null && style) {
          setTimeout(() => {
            const rankWrap = $('display-rank-wrap');
            const labelEl = $('display-rank-label');
            const numRankEl = $('display-rank-num');
            const posEl = $('display-rank-pos');

            labelEl.textContent = style.label;
            labelEl.style.color = style.color;
            numRankEl.textContent = currentRank;
            numRankEl.style.color = style.color;
            posEl.textContent = '/' + currentTotal;

            rankWrap.dataset.tier = style.tier;
            rankWrap.style.setProperty('--rank-color', style.color);
            rankWrap.style.setProperty('--rank-glow', style.glow);
            rankWrap.classList.add('visible');
          }, 500);
        }
      }
    }, stepTime);
  }

  // --- HORS PANEL: glitch + flash + cross slam + screen shake ---
  function showHorsPanel() {
    clearInterval(counterTimer);
    $('display-score-wrap').classList.remove('visible');

    const answer = $('display-answer');
    const flash = $('display-flash');
    const overlay = $('display-hp-overlay');
    const cross = $('display-hp-cross');
    const container = $('display-container');

    // Step 1: Glitch the answer text
    answer.classList.add('glitch');

    // Step 2: After glitch, flash + cross + shake
    setTimeout(() => {
      answer.classList.remove('glitch');
      answer.classList.add('glitched');

      // Red flash
      flash.classList.remove('fire');
      void flash.offsetWidth;
      flash.classList.add('fire');

      // Screen shake
      container.classList.remove('shake');
      void container.offsetWidth;
      container.classList.add('shake');

      // Cross slam in
      overlay.classList.add('visible');
      cross.classList.remove('slam');
      void cross.offsetWidth;
      cross.classList.add('slam');

      // Red vignette
      $('display-vignette').classList.add('visible');
    }, 450);
  }

  function resetDisplay() {
    clearTimeout(typewriterTimer);
    clearInterval(counterTimer);

    const answer = $('display-answer');
    answer.classList.remove('visible', 'glitch', 'glitched');
    $('display-answer-text').innerHTML = '';
    $('display-glow-line').style.width = '';

    $('display-score-wrap').classList.remove('visible', 'pulse');
    $('display-score-num').textContent = '';

    $('display-hp-overlay').classList.remove('visible');
    $('display-hp-cross').classList.remove('slam');
    $('display-vignette').classList.remove('visible');
    $('display-tint').classList.remove('visible');
    $('display-flash').classList.remove('fire');
    $('display-container').classList.remove('shake');

    const rankWrap = $('display-rank-wrap');
    rankWrap.classList.remove('visible');
    delete rankWrap.dataset.tier;
    $('display-rank-label').textContent = '';
    $('display-rank-num').textContent = '';
    $('display-rank-pos').textContent = '';

    currentAnswer = '';
    currentScore = 0;
    currentRank = null;
    currentTotal = null;
  }

  checkAuth();
})();
