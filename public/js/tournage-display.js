(function () {
  const $ = id => document.getElementById(id);
  let eventSource = null;
  let currentScore = 0;
  let currentAnswer = '';
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

  // --- ROLLING COUNTER SCORE ---
  function revealScore() {
    if (currentScore == null) return;
    clearInterval(counterTimer);

    const wrap = $('display-score-wrap');
    const numEl = $('display-score-num');
    const tint = $('display-tint');
    const target = currentScore;

    // Color
    let color, glowColor, tintColor;
    if (target <= 5) {
      color = '#4ADE80'; glowColor = 'rgba(74,222,128,.4)'; tintColor = 'rgba(74,222,128,.06)';
    } else if (target <= 15) {
      color = '#FBBF24'; glowColor = 'rgba(251,191,36,.4)'; tintColor = 'rgba(251,191,36,.06)';
    } else {
      color = '#F87171'; glowColor = 'rgba(248,113,113,.4)'; tintColor = 'rgba(248,113,113,.06)';
    }

    numEl.style.color = color;
    wrap.style.setProperty('--score-glow', glowColor);

    // Show wrap
    numEl.textContent = '0';
    wrap.classList.add('visible');

    // Rolling counter
    let current = 0;
    const duration = 1200; // ms
    const steps = Math.min(target, 40); // max 40 steps
    const stepTime = duration / Math.max(steps, 1);

    counterTimer = setInterval(() => {
      current++;
      const progress = current / steps;
      // Ease out: fast start, slow end
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

    currentAnswer = '';
    currentScore = 0;
  }

  checkAuth();
})();
