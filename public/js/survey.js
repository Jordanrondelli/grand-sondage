(function () {
  const TIMER_DURATION = 30;
  const STORAGE_KEY = 'survey_answered';

  let answeredIds = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  let currentQuestion = null;
  let timerInterval = null;
  let timeLeft = TIMER_DURATION;
  let questionCount = 0;

  // DOM refs
  const screens = {
    welcome: document.getElementById('screen-welcome'),
    question: document.getElementById('screen-question'),
    transition: document.getElementById('screen-transition'),
    done: document.getElementById('screen-done'),
  };
  const questionText = document.getElementById('question-text');
  const questionCounter = document.getElementById('question-counter');
  const answerInput = document.getElementById('answer-input');
  const answerForm = document.getElementById('answer-form');
  const btnStart = document.getElementById('btn-start');
  const btnSubmit = document.getElementById('btn-submit');
  const timerBar = document.getElementById('timer-bar');
  const timerText = document.getElementById('timer-text');

  function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[name].classList.add('active');
  }

  async function fetchNextQuestion() {
    const res = await fetch('/api/questions/next?exclude=' + encodeURIComponent(JSON.stringify(answeredIds)));
    return res.json();
  }

  function startTimer() {
    timeLeft = TIMER_DURATION;
    timerBar.style.width = '100%';
    timerBar.className = 'timer-bar';
    timerText.textContent = timeLeft + 's';

    timerInterval = setInterval(() => {
      timeLeft--;
      timerText.textContent = timeLeft + 's';
      const pct = (timeLeft / TIMER_DURATION) * 100;
      timerBar.style.width = pct + '%';

      if (timeLeft <= 5) {
        timerBar.className = 'timer-bar timer-danger';
      } else if (timeLeft <= 10) {
        timerBar.className = 'timer-bar timer-warning';
      }

      if (timeLeft <= 0) {
        clearInterval(timerInterval);
        handleTimeUp();
      }
    }, 1000);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function handleTimeUp() {
    const val = answerInput.value.trim();
    if (val) {
      submitAnswer(val);
    } else {
      // Skip — mark as answered so user doesn't see it again
      if (currentQuestion) {
        answeredIds.push(currentQuestion.id);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(answeredIds));
      }
      loadNextQuestion();
    }
  }

  async function submitAnswer(text) {
    btnSubmit.disabled = true;
    answerInput.disabled = true;
    stopTimer();

    try {
      await fetch('/api/answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question_id: currentQuestion.id, text }),
      });
    } catch (e) {
      // Continue even on error
    }

    answeredIds.push(currentQuestion.id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(answeredIds));

    // Brief transition
    showScreen('transition');
    setTimeout(() => loadNextQuestion(), 800);
  }

  async function loadNextQuestion() {
    stopTimer();
    try {
      const data = await fetchNextQuestion();
      if (data.done) {
        showScreen('done');
        return;
      }

      currentQuestion = data;
      questionCount++;
      questionCounter.textContent = 'Question ' + questionCount;
      questionText.textContent = data.text;
      answerInput.value = '';
      answerInput.disabled = false;
      btnSubmit.disabled = false;

      showScreen('question');
      answerInput.focus();
      startTimer();
    } catch (e) {
      questionText.textContent = 'Erreur de chargement. Réessaie.';
      showScreen('question');
    }
  }

  // Event listeners
  btnStart.addEventListener('click', () => {
    loadNextQuestion();
  });

  answerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = answerInput.value.trim();
    if (!val || !currentQuestion) return;
    submitAnswer(val);
  });
})();
