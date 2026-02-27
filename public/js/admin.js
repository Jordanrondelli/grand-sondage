(function () {
  const views = {
    login: document.getElementById('view-login'),
    dashboard: document.getElementById('view-dashboard'),
    detail: document.getElementById('view-detail'),
  };

  let categories = [];
  let currentDetailId = null;

  function showView(name) {
    Object.values(views).forEach(v => v.classList.remove('active'));
    views[name].classList.add('active');
  }

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...opts.headers },
    });
    if (res.status === 401) {
      showView('login');
      throw new Error('Non autorisé');
    }
    return res;
  }

  // --------------- Auth ---------------

  async function checkAuth() {
    const res = await fetch('/api/admin/check');
    const data = await res.json();
    if (data.authenticated) {
      showView('dashboard');
      loadDashboard();
    } else {
      showView('login');
    }
  }

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = document.getElementById('login-password').value;
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    if (res.ok) {
      showView('dashboard');
      loadDashboard();
    } else {
      const err = document.getElementById('login-error');
      err.textContent = 'Mot de passe incorrect';
      err.style.display = 'block';
    }
  });

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' });
    showView('login');
  });

  // --------------- Dashboard ---------------

  async function loadDashboard() {
    const [statsRes, questionsRes, catsRes] = await Promise.all([
      api('/api/admin/stats'),
      api('/api/admin/questions'),
      api('/api/admin/categories'),
    ]);

    const stats = await statsRes.json();
    const questions = await questionsRes.json();
    categories = await catsRes.json();

    // Stats
    document.getElementById('stat-total').textContent = stats.totalAnswers;
    document.getElementById('stat-complete').textContent = stats.completeQuestions + '/' + stats.totalQuestions;
    const pct = stats.totalQuestions > 0
      ? Math.round((questions.reduce((s, q) => s + Math.min(q.answer_count, stats.threshold), 0) / (stats.totalQuestions * stats.threshold)) * 100)
      : 0;
    document.getElementById('stat-progress').textContent = pct + '%';
    document.getElementById('progress-bar').style.width = pct + '%';

    // Populate category select
    const catSelect = document.getElementById('form-category');
    catSelect.innerHTML = '<option value="">-- Catégorie --</option>';
    categories.forEach(c => {
      catSelect.innerHTML += `<option value="${c.id}">${esc(c.name)}</option>`;
    });

    // Questions grouped by category
    const grouped = {};
    questions.forEach(q => {
      if (!grouped[q.category_name]) grouped[q.category_name] = [];
      grouped[q.category_name].push(q);
    });

    const container = document.getElementById('questions-list');
    container.innerHTML = '';

    for (const [catName, qs] of Object.entries(grouped)) {
      const section = document.createElement('div');
      section.className = 'category-section';
      section.innerHTML = `<h3 class="category-title">${esc(catName)}</h3>`;
      const list = document.createElement('div');
      list.className = 'question-list';

      qs.forEach(q => {
        const pctQ = Math.min(100, Math.round((q.answer_count / stats.threshold) * 100));
        const isDone = q.answer_count >= stats.threshold;
        const item = document.createElement('div');
        item.className = 'question-item' + (isDone ? ' question-complete' : '');
        item.innerHTML = `
          <div class="question-item-text" data-id="${q.id}">${esc(q.text)}</div>
          <div class="question-item-meta">
            <span class="answer-badge ${isDone ? 'badge-complete' : ''}">${q.answer_count}/${stats.threshold}</span>
            <div class="mini-progress"><div class="mini-bar" style="width:${pctQ}%"></div></div>
            <button class="btn btn-ghost btn-xs" data-edit="${q.id}">✏️</button>
            <button class="btn btn-ghost btn-xs" data-delete="${q.id}">🗑️</button>
          </div>
        `;
        list.appendChild(item);
      });

      section.appendChild(list);
      container.appendChild(section);
    }

    // Click handlers
    container.querySelectorAll('[data-id]').forEach(el => {
      el.addEventListener('click', () => loadDetail(el.dataset.id));
    });
    container.querySelectorAll('[data-edit]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const q = questions.find(x => x.id == el.dataset.edit);
        openEditForm(q);
      });
    });
    container.querySelectorAll('[data-delete]').forEach(el => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Supprimer cette question et toutes ses réponses ?')) return;
        await api('/api/admin/questions/' + el.dataset.delete, { method: 'DELETE' });
        loadDashboard();
      });
    });
  }

  // --------------- Add/Edit Questions ---------------

  document.getElementById('btn-add-question').addEventListener('click', () => {
    document.getElementById('form-question-id').value = '';
    document.getElementById('form-text').value = '';
    document.getElementById('form-category').value = '';
    document.getElementById('form-title').textContent = 'Ajouter une question';
    document.getElementById('question-form-wrapper').style.display = 'block';
  });

  document.getElementById('form-cancel').addEventListener('click', () => {
    document.getElementById('question-form-wrapper').style.display = 'none';
  });

  function openEditForm(q) {
    document.getElementById('form-question-id').value = q.id;
    document.getElementById('form-text').value = q.text;
    document.getElementById('form-category').value = q.category_id;
    document.getElementById('form-title').textContent = 'Modifier la question';
    document.getElementById('question-form-wrapper').style.display = 'block';
  }

  document.getElementById('question-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('form-question-id').value;
    const text = document.getElementById('form-text').value.trim();
    const category_id = document.getElementById('form-category').value;
    if (!text || !category_id) return alert('Remplis tous les champs');

    if (id) {
      await api('/api/admin/questions/' + id, {
        method: 'PUT',
        body: JSON.stringify({ text, category_id: Number(category_id) }),
      });
    } else {
      await api('/api/admin/questions', {
        method: 'POST',
        body: JSON.stringify({ text, category_id: Number(category_id) }),
      });
    }

    document.getElementById('question-form-wrapper').style.display = 'none';
    loadDashboard();
  });

  // --------------- Detail View ---------------

  async function loadDetail(id) {
    currentDetailId = id;
    const res = await api('/api/admin/questions/' + id + '/answers');
    const data = await res.json();

    document.getElementById('detail-question-text').textContent = data.question.text;
    document.getElementById('detail-count').textContent = data.totalCount + '/' + 100 + ' réponses';
    document.getElementById('detail-category').textContent = data.question.category_name;

    // Top 5
    const t5 = document.getElementById('top5-indicator');
    let t5Class = 'top5-neutral';
    let t5Label = 'En attente (pas assez de données)';
    if (data.top5Status === 'good') {
      t5Class = 'top5-good';
      t5Label = `Top 5 = ${data.top5Pct}% — Bonne répartition`;
    } else if (data.top5Status === 'concentrated') {
      t5Class = 'top5-concentrated';
      t5Label = `Top 5 = ${data.top5Pct}% — Trop concentré`;
    } else if (data.top5Status === 'scattered') {
      t5Class = 'top5-scattered';
      t5Label = `Top 5 = ${data.top5Pct}% — Trop éclaté`;
    }
    t5.className = 'top5-indicator ' + t5Class;
    t5.textContent = t5Label;

    // Answers table
    const tbody = document.getElementById('answers-tbody');
    tbody.innerHTML = '';
    data.answers.forEach((a, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input type="checkbox" class="answer-check" data-text="${esc(a.normalized)}"></td>
        <td>${i + 1}</td>
        <td>${esc(a.sample_text)}</td>
        <td>${a.count}</td>
        <td><div class="pct-bar-cell"><div class="pct-bar-fill" style="width:${a.percentage}%"></div><span>${a.percentage}%</span></div></td>
      `;
      tbody.appendChild(tr);
    });

    document.getElementById('merge-tool').style.display = 'none';
    showView('detail');
    updateMergeVisibility();
  }

  // Select all checkbox
  document.getElementById('select-all').addEventListener('change', (e) => {
    document.querySelectorAll('.answer-check').forEach(cb => cb.checked = e.target.checked);
    updateMergeVisibility();
  });

  document.getElementById('answers-tbody').addEventListener('change', () => {
    updateMergeVisibility();
  });

  function updateMergeVisibility() {
    const checked = document.querySelectorAll('.answer-check:checked');
    document.getElementById('merge-tool').style.display = checked.length >= 2 ? 'block' : 'none';
  }

  // Merge
  document.getElementById('btn-merge').addEventListener('click', async () => {
    const checked = document.querySelectorAll('.answer-check:checked');
    const texts = Array.from(checked).map(cb => cb.dataset.text);
    const canonical = document.getElementById('merge-canonical').value.trim();
    if (!canonical) return alert('Donne un texte canonique');

    await api('/api/admin/merge', {
      method: 'POST',
      body: JSON.stringify({
        question_id: Number(currentDetailId),
        answer_texts: texts,
        canonical_text: canonical,
      }),
    });

    document.getElementById('merge-canonical').value = '';
    loadDetail(currentDetailId);
  });

  // Back
  document.getElementById('btn-back').addEventListener('click', () => {
    showView('dashboard');
    loadDashboard();
  });

  // --------------- Export & Reset ---------------

  document.getElementById('btn-export').addEventListener('click', () => {
    window.location.href = '/api/admin/export';
  });

  document.getElementById('btn-reset').addEventListener('click', async () => {
    if (!confirm('Supprimer TOUTES les réponses ? Cette action est irréversible.')) return;
    if (!confirm('Vraiment sûr ? Toutes les données seront perdues.')) return;
    await api('/api/admin/reset', { method: 'POST' });
    loadDashboard();
  });

  // --------------- Helpers ---------------

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // --------------- Init ---------------
  checkAuth();
})();
