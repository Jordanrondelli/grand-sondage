(function () {
  const DURATION = 30;
  const answeredIds = new Set(JSON.parse(localStorage.getItem('answered') || '[]'));
  let currentQ = null, timer = null, timeLeft = DURATION;

  const $ = id => document.getElementById(id);
  const screens = ['welcome','question','registered','timeout','done'];
  function show(name) {
    screens.forEach(s => $('screen-' + s).classList.remove('active'));
    $('screen-' + name).classList.add('active');
  }

  // Welcome
  function updateAlready() {
    const n = answeredIds.size;
    const el = $('already');
    if (n > 0) { el.textContent = 'Tu as déjà répondu à ' + n + ' question' + (n > 1 ? 's' : ''); el.style.display = ''; }
    else { el.style.display = 'none'; }
  }

  // Timer
  function timerColor(t) { return t > 15 ? 'green' : t > 8 ? 'orange' : 'red'; }

  function startTimer() {
    timeLeft = DURATION;
    const fill = $('timer-fill');
    const num = $('timer-num');
    fill.style.width = '100%';
    fill.className = 'timer-fill green';
    num.textContent = timeLeft;
    num.className = 'timer-num green';

    timer = setInterval(() => {
      timeLeft--;
      const c = timerColor(timeLeft);
      fill.style.width = ((timeLeft / DURATION) * 100) + '%';
      fill.className = 'timer-fill ' + c;
      num.textContent = timeLeft;
      num.className = 'timer-num ' + c;
      if (timeLeft <= 0) { stopTimer(); show('timeout'); }
    }, 1000);
  }

  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

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
          : 'Toutes les questions ont atteint 100 réponses. Le sondage est terminé !';
        show('done');
        return;
      }
      currentQ = data;
      $('q-text').textContent = data.text;
      input.value = '';
      input.disabled = false;
      btnVal.classList.add('dim');
      const fc = $('fire-count');
      if (answeredIds.size > 0) { fc.textContent = answeredIds.size + ' réponses 🔥'; fc.style.display = ''; }
      else { fc.style.display = 'none'; }
      show('question');
      input.focus();
      startTimer();
    } catch { show('done'); }
  }

  // Submit
  async function submit() {
    const val = input.value.trim();
    if (!val || !currentQ) return;
    stopTimer();
    input.disabled = true;
    try {
      const resp = await fetch('/api/answers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question_id: currentQ.id, text: val }) });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        if (err.error === 'Réponse incohérente') {
          input.disabled = false;
          input.value = '';
          input.placeholder = 'Écris une vraie réponse !';
          startTimer();
          return;
        }
      }
    } catch {}
    answeredIds.add(currentQ.id);
    localStorage.setItem('answered', JSON.stringify([...answeredIds]));
    updateAlready();
    show('registered');
  }

  // Skip
  function skip() {
    stopTimer();
    if (currentQ) { answeredIds.add(currentQ.id); localStorage.setItem('answered', JSON.stringify([...answeredIds])); updateAlready(); }
    loadNext();
  }

  // Events
  $('btn-start').onclick = () => { updateAlready(); loadNext(); };
  $('btn-validate').onclick = submit;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  $('btn-skip').onclick = skip;
  $('btn-next-ok').onclick = loadNext;
  $('btn-next-timeout').onclick = skip;

  updateAlready();
})();
