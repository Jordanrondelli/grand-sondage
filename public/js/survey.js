(function () {
  const DURATION = 45;
  const answeredIds = new Set(JSON.parse(localStorage.getItem('answered') || '[]'));
  let currentQ = null, timer = null, timeLeft = DURATION, pendingAnswer = null;

  const $ = id => document.getElementById(id);
  const screens = ['welcome','question','confirm','registered','timeout','done'];
  function show(name) {
    screens.forEach(s => $('screen-' + s).classList.remove('active'));
    $('screen-' + name).classList.add('active');
  }

  const MOTIVATIONAL = [
    'Bien joué !', 'Merci pour ta réponse !', 'Continue comme ça !',
    'Une de plus !', 'Tu gères !', 'Parfait !', 'Top !', 'Excellent !'
  ];

  // Welcome
  function updateAlready() {
    const n = answeredIds.size;
    const el = $('already');
    if (n > 0) { el.textContent = 'Tu as déjà répondu à ' + n + ' question' + (n > 1 ? 's' : ''); el.style.display = ''; }
    else { el.style.display = 'none'; }
  }

  async function loadParticipantCount() {
    try {
      const res = await fetch('/api/stats/participants');
      const data = await res.json();
      if (data.count > 0) {
        $('participant-count').textContent = data.count + ' personnes ont déjà participé';
      }
    } catch {}
  }

  // Timer
  function timerColor(t) { return t > 15 ? 'white' : t > 5 ? 'orange' : 'red'; }

  function startTimer() {
    timeLeft = DURATION;
    const fill = $('timer-fill');
    const num = $('timer-num');
    fill.style.width = '100%';
    fill.className = 'timer-fill white';
    num.textContent = timeLeft;
    num.className = 'timer-num-small white';

    timer = setInterval(() => {
      timeLeft--;
      const c = timerColor(timeLeft);
      fill.style.width = ((timeLeft / DURATION) * 100) + '%';
      fill.className = 'timer-fill ' + c;
      num.textContent = timeLeft;
      num.className = 'timer-num-small ' + c;
      if (timeLeft <= 0) { stopTimer(); show('timeout'); }
    }, 1000);
  }

  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
  function getResponseTime() { return DURATION - timeLeft; }

  function resumeTimer() {
    timer = setInterval(() => {
      timeLeft--;
      const c = timerColor(timeLeft);
      $('timer-fill').style.width = ((timeLeft / DURATION) * 100) + '%';
      $('timer-fill').className = 'timer-fill ' + c;
      $('timer-num').textContent = timeLeft;
      $('timer-num').className = 'timer-num-small ' + c;
      if (timeLeft <= 0) { stopTimer(); show('timeout'); }
    }, 1000);
  }

  // Input handling
  const input = $('answer-input');
  const btnVal = $('btn-validate');
  input.addEventListener('input', () => {
    btnVal.classList.toggle('dim', !input.value.trim());
  });

  // Load question
  async function loadNext() {
    stopTimer();
    try {
      const res = await fetch('/api/questions/next?exclude=' + encodeURIComponent(JSON.stringify([...answeredIds])));
      const data = await res.json();
      if (data.done) {
        $('done-text').textContent = answeredIds.size > 0
          ? 'Tu as répondu à ' + answeredIds.size + ' questions. C\'est top !'
          : 'Toutes les questions ont atteint leurs réponses. Le sondage est terminé !';
        show('done');
        return;
      }
      currentQ = data;
      $('q-text').textContent = data.text;
      input.value = '';
      input.disabled = false;
      input.placeholder = 'Ta réponse...';
      btnVal.classList.add('dim');
      const fc = $('fire-count');
      if (answeredIds.size > 0) { fc.textContent = answeredIds.size + ' réponses 🔥'; fc.style.display = ''; }
      else { fc.style.display = 'none'; }
      show('question');
      input.focus();
      startTimer();
    } catch { show('done'); }
  }

  // Show confirmation screen (timer pauses)
  function showConfirmation() {
    const val = input.value.trim();
    if (!val || !currentQ) return;
    pendingAnswer = val;
    stopTimer(); // Pause timer
    $('confirm-answer-text').textContent = val.toUpperCase();
    show('confirm');
  }

  // Confirm and submit
  async function confirmSubmit() {
    if (!pendingAnswer || !currentQ) return;
    const rt = getResponseTime();
    try {
      const resp = await fetch('/api/answers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question_id: currentQ.id, text: pendingAnswer, response_time: rt }) });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        if (err.troll) {
          input.disabled = false;
          input.value = '';
          input.placeholder = 'Donne une vraie réponse 😉';
          pendingAnswer = null;
          show('question');
          resumeTimer();
          return;
        }
      }
    } catch {}
    answeredIds.add(currentQ.id);
    localStorage.setItem('answered', JSON.stringify([...answeredIds]));
    updateAlready();
    pendingAnswer = null;
    // Gamification
    $('motivational-msg').textContent = MOTIVATIONAL[Math.floor(Math.random() * MOTIVATIONAL.length)];
    $('personal-counter').textContent = 'Tu as répondu à ' + answeredIds.size + ' question' + (answeredIds.size > 1 ? 's' : '') + ' 🔥';
    show('registered');
  }

  // Edit: go back to input with answer pre-filled
  function editAnswer() {
    input.value = pendingAnswer || '';
    btnVal.classList.toggle('dim', !input.value.trim());
    pendingAnswer = null;
    show('question');
    input.focus();
    resumeTimer(); // Resume timer from where it was
  }

  // Skip
  function skip() {
    stopTimer();
    if (currentQ) {
      fetch('/api/questions/' + currentQ.id + '/skip', { method: 'POST' }).catch(() => {});
      answeredIds.add(currentQ.id);
      localStorage.setItem('answered', JSON.stringify([...answeredIds]));
      updateAlready();
    }
    loadNext();
  }

  // Events
  $('btn-start').onclick = () => { updateAlready(); loadNext(); };
  $('btn-validate').onclick = showConfirmation;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); showConfirmation(); } });
  $('btn-confirm-yes').onclick = confirmSubmit;
  $('btn-confirm-edit').onclick = editAnswer;
  $('btn-skip').onclick = skip;
  $('btn-next-ok').onclick = loadNext;
  $('btn-next-timeout').onclick = skip;

  updateAlready();
  loadParticipantCount();
})();
