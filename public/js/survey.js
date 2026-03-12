(function () {
  const DURATION = 45;
  const CIRCUMFERENCE = 2 * Math.PI * 46; // radius=46
  const ENCOURAGING = ['Bien joué !', 'Merci !', 'Continue !', 'Une de plus !', 'Tu gères !', 'Parfait !', 'Top !', 'Excellent !'];
  const CLUB_HUES = { 'Le Glouton Club': 30, 'Metronomus': 280, 'Red carpet': 340, 'La situation': 180 };
  const CONFETTI_COLORS = ['#FF6B8A', '#FFB347', '#9B8FFF', '#22C55E', '#FF8E72', '#C4B5FD', '#FFDA77'];

  // Survey ID from URL ?s=<id> or from slug (path like /mon-sondage)
  let surveyId = new URLSearchParams(window.location.search).get('s') || '';
  const slug = (!surveyId && window.location.pathname !== '/' && !window.location.pathname.startsWith('/admin') && !window.location.pathname.startsWith('/tournage'))
    ? window.location.pathname.replace(/^\//, '').replace(/\/$/, '') : '';

  // Will be set after init resolves slug → id
  let storageKey, apiSuffix, answeredIds, demoKey, demographics, respondentId;
  let currentQ = null, timer = null, timeLeft = DURATION, pendingAnswer = null, currentHue = 260, currentMaxLen = 40;
  let countdownTimer = null, countdownLeft = 15, skipAllowed = true;

  function generateId() {
    return 'xxxxxxxx-xxxx-4xxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16)) + '-' + Date.now().toString(36);
  }

  function initSurveyKeys() {
    storageKey = surveyId ? 'answered_s' + surveyId : 'answered';
    apiSuffix = surveyId ? (url => url + (url.includes('?') ? '&' : '?') + 's=' + surveyId) : (url => url);
    answeredIds = new Set(JSON.parse(localStorage.getItem(storageKey) || '[]'));
    demoKey = surveyId ? 'demo_s' + surveyId : 'demo';
    demographics = JSON.parse(localStorage.getItem(demoKey) || 'null');
    // Unique respondent ID per survey — persists in localStorage
    const ridKey = surveyId ? 'rid_s' + surveyId : 'rid';
    respondentId = localStorage.getItem(ridKey);
    if (!respondentId) {
      respondentId = generateId();
      localStorage.setItem(ridKey, respondentId);
    }
  }

  const $ = id => document.getElementById(id);
  const screens = ['welcome', 'demographics', 'reminder', 'question', 'registered', 'timeout', 'done'];

  function show(name) {
    screens.forEach(s => $('screen-' + s).classList.remove('active'));
    $('screen-' + name).classList.add('active');
  }

  // ============================================================
  // ANIMATED BACKGROUND
  // ============================================================
  function initBackground() {
    const bg = $('animated-bg');
    bg.innerHTML = '';
    // Grain overlay
    const grain = document.createElement('div');
    grain.className = 'bg-grain';
    bg.appendChild(grain);
    // Grid
    const grid = document.createElement('div');
    grid.className = 'bg-grid';
    bg.appendChild(grid);
    // Orbs
    for (let i = 1; i <= 3; i++) {
      const orb = document.createElement('div');
      orb.className = 'bg-orb bg-orb-' + i;
      orb.id = 'bg-orb-' + i;
      bg.appendChild(orb);
    }
    // Pulse overlay
    const pulse = document.createElement('div');
    pulse.className = 'bg-pulse';
    pulse.id = 'bg-pulse';
    bg.appendChild(pulse);
    // Particles
    for (let i = 0; i < 20; i++) {
      const p = document.createElement('div');
      p.className = 'bg-particle';
      const left = Math.random() * 100;
      const delay = Math.random() * 20;
      const dur = 18 + Math.random() * 20;
      const size = 2 + Math.random() * 3;
      const opacity = 0.08 + Math.random() * 0.15;
      const drift = (Math.random() - 0.5) * 60;
      p.style.cssText = `left:${left}%;width:${size}px;height:${size}px;opacity:${opacity};animation:particleRise ${dur}s ${delay}s linear infinite;--drift:${drift}px`;
      p.dataset.hueOffset = ((Math.random() - 0.5) * 60).toFixed(0);
      bg.appendChild(p);
    }
    setHue(260);
  }

  function setHue(hue) {
    currentHue = hue;
    const bg = $('animated-bg');
    bg.style.background = `linear-gradient(160deg, hsl(${hue},30%,8%) 0%, hsl(${hue + 20},25%,4%) 50%, hsl(${hue - 20},20%,6%) 100%)`;
    $('bg-orb-1').style.background = `radial-gradient(circle, hsla(${hue + 40},80%,50%,0.08) 0%, transparent 70%)`;
    $('bg-orb-2').style.background = `radial-gradient(circle, hsla(${hue - 30},70%,40%,0.07) 0%, transparent 70%)`;
    $('bg-orb-3').style.background = `radial-gradient(circle, hsla(${hue + 80},60%,55%,0.05) 0%, transparent 70%)`;
    document.querySelectorAll('.bg-particle').forEach(p => {
      const off = parseInt(p.dataset.hueOffset || 0);
      const op = parseFloat(p.style.opacity) || 0.1;
      p.style.background = `hsla(${hue + off},70%,70%,${op})`;
    });
  }

  function setPulse(intensity) {
    const pulse = $('bg-pulse');
    if (intensity <= 0) {
      pulse.style.opacity = '0';
      return;
    }
    pulse.style.opacity = '1';
    if (intensity > 0.6) {
      pulse.style.background = `radial-gradient(circle at 50% 50%, hsla(0,80%,50%,${(intensity * 0.08).toFixed(3)}) 0%, transparent 70%)`;
    } else {
      pulse.style.background = `radial-gradient(circle at 50% 50%, hsla(30,80%,50%,${(intensity * 0.05).toFixed(3)}) 0%, transparent 70%)`;
    }
  }

  // ============================================================
  // LOGO SVG
  // ============================================================
  function initLogo() {
    $('logo-3d').innerHTML = `<svg viewBox="0 0 120 120" width="120" height="120">
      <defs>
        <linearGradient id="face" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#FF6B8A"/><stop offset="50%" stop-color="#FF8E72"/><stop offset="100%" stop-color="#FFB347"/>
        </linearGradient>
        <linearGradient id="shadow" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#b8405a"/><stop offset="100%" stop-color="#b5622e"/>
        </linearGradient>
        <linearGradient id="highlight" x1="20%" y1="0%" x2="80%" y2="100%">
          <stop offset="0%" stop-color="#fff" stop-opacity="0.6"/><stop offset="100%" stop-color="#fff" stop-opacity="0"/>
        </linearGradient>
        <filter id="bigShadow"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#000" flood-opacity="0.35"/></filter>
      </defs>
      <path d="M 38 28 Q 38 10, 62 10 Q 86 10, 86 28 Q 86 42, 68 50 Q 62 53, 62 62 L 62 66" stroke="url(#shadow)" stroke-width="16" stroke-linecap="round" fill="none" transform="translate(4,4)"/>
      <circle cx="62" cy="86" r="9" fill="url(#shadow)" transform="translate(4,4)"/>
      <path d="M 38 28 Q 38 10, 62 10 Q 86 10, 86 28 Q 86 42, 68 50 Q 62 53, 62 62 L 62 66" stroke="url(#face)" stroke-width="16" stroke-linecap="round" fill="none" filter="url(#bigShadow)"/>
      <circle cx="62" cy="86" r="9" fill="url(#face)" filter="url(#bigShadow)"/>
      <path d="M 42 26 Q 42 16, 58 14 Q 68 13, 74 18" stroke="url(#highlight)" stroke-width="6" stroke-linecap="round" fill="none"/>
      <circle cx="59" cy="83" r="3.5" fill="white" opacity="0.3"/>
      <g>
        <circle cx="95" cy="14" r="3" fill="#FFB347" opacity="0.9"><animate attributeName="opacity" values="0.9;0.2;0.9" dur="1.8s" repeatCount="indefinite"/><animate attributeName="r" values="3;4;3" dur="1.8s" repeatCount="indefinite"/></circle>
        <circle cx="22" cy="50" r="2.5" fill="#9B8FFF" opacity="0.7"><animate attributeName="opacity" values="0.7;0.1;0.7" dur="2.2s" repeatCount="indefinite"/><animate attributeName="r" values="2.5;3.5;2.5" dur="2.2s" repeatCount="indefinite"/></circle>
        <circle cx="88" cy="70" r="2" fill="#FF6B8A" opacity="0.8"><animate attributeName="opacity" values="0.8;0.2;0.8" dur="2s" repeatCount="indefinite"/><animate attributeName="r" values="2;3;2" dur="2s" repeatCount="indefinite"/></circle>
        <circle cx="30" cy="18" r="1.5" fill="#C4B5FD" opacity="0.6"><animate attributeName="opacity" values="0.6;0.1;0.6" dur="2.8s" repeatCount="indefinite"/></circle>
      </g>
    </svg>`;
  }

  // ============================================================
  // CONFETTI
  // ============================================================
  function burstConfetti() {
    const container = $('confetti-container');
    container.innerHTML = '';
    for (let i = 0; i < 40; i++) {
      const p = document.createElement('div');
      const x = (Math.random() - 0.5) * 500;
      const y = -(100 + Math.random() * 300);
      const r = Math.random() * 720 - 360;
      const color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
      const size = 5 + Math.random() * 8;
      const delay = Math.random() * 0.3;
      const isRound = Math.random() > 0.5;
      p.style.cssText = `position:absolute;left:50%;top:50%;width:${isRound ? size : size * 0.6}px;height:${size}px;border-radius:${isRound ? '50%' : '2px'};background:${color};animation:confetti 1.2s ${delay}s cubic-bezier(0.25,0.46,0.45,0.94) forwards;transform:translate(-50%,-50%);--x:${x}px;--y:${y}px;--r:${r}deg;opacity:0`;
      container.appendChild(p);
    }
    setTimeout(() => { container.innerHTML = ''; }, 2000);
  }

  // ============================================================
  // CHECKBOXES
  // ============================================================
  const checks = [false, false, false];

  function updateCheckboxes() {
    document.querySelectorAll('.check-card').forEach(card => {
      const i = parseInt(card.dataset.rule);
      card.classList.toggle('checked', checks[i]);
      card.querySelector('.checkbox').textContent = checks[i] ? '✓' : '';
    });
    const allChecked = checks.every(Boolean);
    const canStart = allChecked && countdownLeft <= 0;
    const btn = $('btn-start');
    btn.classList.toggle('disabled', !canStart);
    if (allChecked && countdownLeft > 0) {
      btn.textContent = 'Patiente encore... (' + countdownLeft + 's)';
    } else if (allChecked) {
      btn.textContent = "C'est parti";
    } else if (countdownLeft > 0) {
      btn.textContent = 'Lis bien les règles... (' + countdownLeft + 's)';
    } else {
      btn.textContent = 'Coche les règles ci-dessus';
    }
  }

  function startCountdown() {
    countdownLeft = 15;
    updateCheckboxes();
    countdownTimer = setInterval(() => {
      countdownLeft--;
      if (countdownLeft <= 0) { clearInterval(countdownTimer); countdownTimer = null; countdownLeft = 0; }
      updateCheckboxes();
    }, 1000);
  }

  document.querySelectorAll('.check-card').forEach(card => {
    card.addEventListener('click', () => {
      const i = parseInt(card.dataset.rule);
      checks[i] = !checks[i];
      updateCheckboxes();
    });
  });

  // ============================================================
  // TIMER
  // ============================================================
  function getTimerColors(t) {
    if (t <= 5) return { color: '#FF4D6A', light: '#FF8E72', glow: 'rgba(255,77,106,0.6)', glowSize: 22 };
    if (t <= 15) return { color: '#FFB347', light: '#FFDA77', glow: 'rgba(255,179,71,0.4)', glowSize: 14 };
    return { color: '#9B8FFF', light: '#C4B5FD', glow: 'rgba(155,143,255,0.2)', glowSize: 6 };
  }

  function updateTimerVisuals() {
    const pct = timeLeft / DURATION;
    const offset = CIRCUMFERENCE * (1 - pct);
    const tc = getTimerColors(timeLeft);
    const circle = $('timer-circle');
    const num = $('timer-number');
    const wrap = $('circular-timer-wrap');
    const glow = $('timer-glow');
    const topFill = $('top-timer-fill');

    // Circular timer
    circle.setAttribute('stroke-dashoffset', offset);
    circle.style.filter = `drop-shadow(0 0 ${tc.glowSize}px ${tc.glow})`;
    $('timer-stop1').setAttribute('stop-color', tc.color);
    $('timer-stop2').setAttribute('stop-color', tc.light);
    num.textContent = timeLeft;
    num.style.color = tc.color;
    num.style.textShadow = `0 0 ${tc.glowSize}px ${tc.glow}`;

    // Shake under 5s
    wrap.style.animation = timeLeft <= 5 ? 'timerShake 0.3s ease infinite' : 'none';

    // Glow
    glow.style.background = `radial-gradient(circle, ${tc.glow} 0%, transparent 70%)`;
    if (timeLeft <= 15) {
      glow.style.opacity = '1';
      glow.classList.add('active');
    } else {
      glow.style.opacity = '0';
      glow.classList.remove('active');
    }

    // Top bar
    topFill.style.width = (pct * 100) + '%';
    if (timeLeft <= 5) {
      topFill.style.background = 'linear-gradient(90deg, #FF4D6A, #FF6B8A)';
      topFill.style.boxShadow = '0 0 15px rgba(255,77,106,0.6)';
    } else if (timeLeft <= 15) {
      topFill.style.background = 'linear-gradient(90deg, #FFB347, #FFDA77)';
      topFill.style.boxShadow = '0 0 10px rgba(255,179,71,0.4)';
    } else {
      topFill.style.background = 'linear-gradient(90deg, rgba(255,255,255,0.15), rgba(255,255,255,0.3))';
      topFill.style.boxShadow = 'none';
    }

    // Screen pulse
    const pulseIntensity = timeLeft <= 5 ? 1 : timeLeft <= 15 ? (15 - timeLeft) / 15 : 0;
    setPulse(pulseIntensity);
  }

  function startTimer() {
    timeLeft = DURATION;
    updateTimerVisuals();
    timer = setInterval(() => {
      timeLeft--;
      updateTimerVisuals();
      if (timeLeft <= 0) { stopTimer(); show('timeout'); setHue(20); }
    }, 1000);
  }

  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
  function getResponseTime() { return DURATION - timeLeft; }

  function resumeTimer() {
    timer = setInterval(() => {
      timeLeft--;
      updateTimerVisuals();
      if (timeLeft <= 0) { stopTimer(); show('timeout'); setHue(20); }
    }, 1000);
  }

  // ============================================================
  // CLIENT-SIDE GIBBERISH CHECK
  // ============================================================
  function looksLikeGibberish(text) {
    const s = text.replace(/[\s'''-]/g, '');
    if (s.length < 2) return true;
    if (/^(.)\1+$/.test(s)) return true;
    if (!/[aeiouyàâäéèêëïîôùûüÿœæ0-9]/i.test(s)) return true;
    if (/[bcdfghjklmnpqrstvwxz]{5}/i.test(s)) return true;
    if (/([bcdfghjklmnpqrstvwxz])\1{2}/i.test(s)) return true;
    if (s.length >= 6) {
      const freq = {};
      for (const ch of s) freq[ch] = (freq[ch] || 0) + 1;
      if (Math.max(...Object.values(freq)) / s.length > 0.6) return true;
    }
    if (/^(.{1,3})\1{2,}$/i.test(s)) return true;
    if (/([aeiouyàâäéèêëïîôùûüÿœæ])\1{2}/i.test(s)) return true;
    return false;
  }

  function shakeInput() {
    const group = $('input-group');
    const inp = $('answer-input');
    group.classList.remove('shake');
    void group.offsetWidth;
    group.classList.add('shake');
    inp.classList.add('blocked');
    inp.disabled = true;
    setTimeout(() => {
      inp.classList.remove('blocked');
      inp.disabled = false;
      inp.focus();
    }, 800);
  }

  // ============================================================
  // INPUT
  // ============================================================
  const input = $('answer-input');
  const btnVal = $('btn-validate');
  input.addEventListener('input', () => {
    const val = input.value;
    // Hard block if over maxLength (extra safety)
    if (currentMaxLen < 200 && val.length > currentMaxLen) {
      input.value = val.slice(0, currentMaxLen);
      shakeInput();
      return;
    }
    // Check gibberish on 3+ chars
    if (val.trim().length >= 3 && looksLikeGibberish(val.trim())) {
      shakeInput();
      return;
    }
    btnVal.classList.toggle('disabled', !val.trim());
    updateCharCount();
  });

  function updateCharCount() {
    var rem = $('input-reminder');
    if (!rem) return;
    if (currentMaxLen >= 200) {
      rem.textContent = input.value.length + ' caractères';
      rem.style.color = 'rgba(255,180,100,0.5)';
    } else {
      var left = currentMaxLen - input.value.length;
      rem.textContent = left + ' / ' + currentMaxLen + ' caractères';
      rem.style.color = left <= 3 ? 'rgba(255,80,80,0.9)' : left <= 8 ? 'rgba(255,180,100,0.8)' : 'rgba(255,180,100,0.5)';
    }
  }

  // ============================================================
  // WELCOME
  // ============================================================
  function updateAlready() {
    const n = answeredIds.size;
    const el = $('already');
    if (n > 0) { el.textContent = 'Tu as déjà répondu à ' + n + ' question' + (n > 1 ? 's' : ''); el.style.display = ''; }
    else { el.style.display = 'none'; }
  }

  async function loadParticipantCount() {
    try {
      const res = await fetch(apiSuffix('/api/stats/participants'));
      const data = await res.json();
      if (data.count > 0) {
        $('participant-text').textContent = data.count.toLocaleString() + ' personnes ont déjà participé';
        $('live-counter').style.display = '';
      }
    } catch {}
  }

  // ============================================================
  // LOAD QUESTION
  // ============================================================
  async function loadNext() {
    stopTimer();
    setPulse(0);
    try {
      let nextUrl = '/api/questions/next?exclude=' + encodeURIComponent(JSON.stringify([...answeredIds]));
      if (demographics) nextUrl += '&gender=' + demographics.gender + '&age=' + demographics.age;
      const res = await fetch(apiSuffix(nextUrl));
      const data = await res.json();
      if (data.done) {
        $('done-text').textContent = answeredIds.size > 0
          ? answeredIds.size + ' question' + (answeredIds.size > 1 ? 's' : '') + ' — c\'est top !'
          : 'Le sondage est terminé !';
        show('done');
        setHue(150);
        burstConfetti();
        return;
      }
      currentQ = data;
      currentMaxLen = data.maxLength || 40;
      const hue = CLUB_HUES[data.club] || 260;
      setHue(hue);
      $('q-text').textContent = data.text;
      input.value = '';
      input.disabled = false;
      if (currentMaxLen >= 200) {
        input.removeAttribute('maxLength');
        input.placeholder = 'Ta réponse...';
      } else {
        input.maxLength = currentMaxLen;
        input.placeholder = 'Ta réponse... (' + currentMaxLen + ' car. max)';
      }
      updateCharCount();
      btnVal.classList.add('disabled');
      $('phase-input').style.display = '';
      $('phase-confirm').style.display = 'none';
      $('btn-skip').style.display = skipAllowed ? '' : 'none';
      show('question');
      input.focus();
      startTimer();
    } catch { show('done'); setHue(150); }
  }

  // ============================================================
  // CONFIRMATION
  // ============================================================
  function showConfirmation() {
    const val = input.value.trim();
    if (!val || !currentQ) return;
    if (looksLikeGibberish(val)) { shakeInput(); return; }
    pendingAnswer = val;
    stopTimer();
    setPulse(0);
    $('confirm-answer-text').textContent = val.toUpperCase();
    $('phase-input').style.display = 'none';
    $('phase-confirm').style.display = '';
    // Re-trigger animation
    const box = $('phase-confirm').querySelector('.confirm-box');
    box.classList.remove('anim-popin');
    void box.offsetWidth;
    box.classList.add('anim-popin');
  }

  async function confirmSubmit() {
    if (!pendingAnswer || !currentQ) return;
    const rt = getResponseTime();
    try {
      const resp = await fetch(apiSuffix('/api/answers'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question_id: currentQ.id, text: pendingAnswer, response_time: rt, survey_id: surveyId ? Number(surveyId) : undefined, gender: demographics?.gender, age: demographics?.age, respondent_id: respondentId }) });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        if (err.troll) {
          input.disabled = false;
          input.value = '';
          input.placeholder = 'Donne une vraie réponse 😉';
          pendingAnswer = null;
          $('phase-input').style.display = '';
          $('phase-confirm').style.display = 'none';
          show('question');
          resumeTimer();
          return;
        }
      }
    } catch {}
    answeredIds.add(currentQ.id);
    localStorage.setItem(storageKey, JSON.stringify([...answeredIds]));
    updateAlready();
    pendingAnswer = null;
    // Gamification
    $('motivational-msg').textContent = ENCOURAGING[Math.floor(Math.random() * ENCOURAGING.length)];
    $('personal-counter').textContent = answeredIds.size + ' réponse' + (answeredIds.size > 1 ? 's' : '') + ' 🔥';
    // Re-trigger animations
    $('reg-emoji').classList.remove('anim-celebrate');
    void $('reg-emoji').offsetWidth;
    $('reg-emoji').classList.add('anim-celebrate');
    show('registered');
    setHue(150);
    burstConfetti();
  }

  function editAnswer() {
    input.value = pendingAnswer || '';
    btnVal.classList.toggle('disabled', !input.value.trim());
    pendingAnswer = null;
    $('phase-input').style.display = '';
    $('phase-confirm').style.display = 'none';
    input.focus();
    resumeTimer();
  }

  // ============================================================
  // SKIP
  // ============================================================
  function skip() {
    stopTimer();
    if (currentQ) {
      fetch(apiSuffix('/api/questions/' + currentQ.id + '/skip'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ survey_id: surveyId ? Number(surveyId) : undefined }) }).catch(() => {});
      answeredIds.add(currentQ.id);
      localStorage.setItem(storageKey, JSON.stringify([...answeredIds]));
      updateAlready();
    }
    loadNext();
  }

  // ============================================================
  // EVENTS
  // ============================================================
  // Fetch skip setting — called from boot() after slug resolution
  function loadSkipSetting() {
    fetch(apiSuffix('/api/settings/allow-skip')).then(r => r.json()).then(d => {
      skipAllowed = d.enabled;
      $('btn-skip').style.display = skipAllowed ? '' : 'none';
    }).catch(() => {});
  }

  $('btn-start').addEventListener('click', () => {
    if (checks.every(Boolean) && countdownLeft <= 0) {
      updateAlready();
      if (demographics) { show('reminder'); startReminderCountdown(); } else { show('demographics'); }
    }
  });

  // ============================================================
  // DEMOGRAPHICS
  // ============================================================
  (function initDemoScreen() {
    let selectedGender = null;
    const genderBtns = document.querySelectorAll('.demo-gender-btn');
    const ageInput = $('demo-age');
    const ageError = $('demo-age-error');
    const startBtn = $('btn-demo-start');

    function getValidAge() {
      const val = ageInput.value.trim();
      if (!/^\d{2}$/.test(val)) return null;
      const n = Number(val);
      return (n >= 10 && n <= 77) ? n : null;
    }

    function updateDemoBtn() {
      const ageOk = getValidAge() !== null;
      startBtn.classList.toggle('disabled', !selectedGender || !ageOk);
      if (ageInput.value.trim() && !ageOk) {
        ageError.textContent = 'Entre un âge valide (2 chiffres, entre 10 et 77)';
      } else {
        ageError.textContent = '';
      }
    }

    // Only allow digits
    ageInput.addEventListener('input', () => {
      ageInput.value = ageInput.value.replace(/[^0-9]/g, '');
      updateDemoBtn();
    });
    ageInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); startBtn.click(); }
    });

    genderBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        genderBtns.forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedGender = btn.dataset.gender;
        updateDemoBtn();
      });
    });

    startBtn.addEventListener('click', () => {
      const age = getValidAge();
      if (!selectedGender || !age) return;
      demographics = { gender: selectedGender, age: age };
      localStorage.setItem(demoKey, JSON.stringify(demographics));
      show('reminder');
      startReminderCountdown();
    });
  })();

  // ============================================================
  // REMINDER COUNTDOWN
  // ============================================================
  let reminderTimer = null;
  function startReminderCountdown() {
    let left = 10;
    const btn = $('btn-reminder-go');
    btn.classList.add('disabled');
    btn.textContent = 'Lis bien... (' + left + ')';
    reminderTimer = setInterval(() => {
      left--;
      if (left <= 0) {
        clearInterval(reminderTimer);
        btn.classList.remove('disabled');
        btn.textContent = 'J\'ai compris, c\'est parti !';
      } else {
        btn.textContent = 'Lis bien... (' + left + ')';
      }
    }, 1000);
  }

  $('btn-reminder-go').addEventListener('click', () => {
    if ($('btn-reminder-go').classList.contains('disabled')) return;
    loadNext();
  });

  $('btn-validate').addEventListener('click', () => { if (!btnVal.classList.contains('disabled')) showConfirmation(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (!btnVal.classList.contains('disabled')) showConfirmation(); } });
  $('btn-confirm-yes').addEventListener('click', confirmSubmit);
  $('btn-confirm-edit').addEventListener('click', editAnswer);
  $('btn-skip').addEventListener('click', skip);
  $('btn-next-ok').addEventListener('click', loadNext);
  $('btn-next-timeout').addEventListener('click', skip);

  // ============================================================
  // INIT
  // ============================================================
  async function boot() {
    // Resolve slug → survey ID if needed
    if (slug && !surveyId) {
      try {
        const r = await fetch('/api/survey-info?slug=' + encodeURIComponent(slug));
        const d = await r.json();
        if (d.id) surveyId = String(d.id);
      } catch (e) { /* fallback: no survey */ }
    }
    initSurveyKeys();

    // Check demo_version — if server bumped it, clear local demographics
    if (surveyId) {
      try {
        const r = await fetch('/api/survey-info?s=' + surveyId);
        const d = await r.json();
        if (d.demo_version) {
          const vKey = 'demo_v_s' + surveyId;
          const localV = Number(localStorage.getItem(vKey) || '0');
          if (localV && localV < d.demo_version) {
            // Server reset demographics — clear local data + generate new respondent ID
            localStorage.removeItem(demoKey);
            demographics = null;
            const ridKey = surveyId ? 'rid_s' + surveyId : 'rid';
            respondentId = generateId();
            localStorage.setItem(ridKey, respondentId);
          }
          localStorage.setItem(vKey, String(d.demo_version));
        }
      } catch (e) { /* ignore */ }
    }

    initBackground();
    initLogo();
    updateAlready();
    startCountdown();
    loadParticipantCount();
    loadSkipSetting();
  }
  boot();
})();
