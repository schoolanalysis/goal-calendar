(function () {
  let data = {};
  let saveTimer = null;

  function keyFor(y, m, d) {
    return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const res = await fetch('/api/goals', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goals: data })
        });
        if (res.status === 401) {
          window.location.href = '/login.html';
        }
      } catch (e) {
        console.error('Could not save goals', e);
      }
    }, 300);
  }

  const today = new Date();
  let viewYear = today.getFullYear();
  let viewMonth = today.getMonth();
  let activeKey = null;

  const monthLabel = document.getElementById('monthLabel');
  const yearLabel = document.getElementById('yearLabel');
  const grid = document.getElementById('grid');
  const overlay = document.getElementById('overlay');
  const panelDate = document.getElementById('panelDate');
  const goalList = document.getElementById('goalList');
  const addInput = document.getElementById('addInput');

  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const WEEKDAY_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  function render() {
    monthLabel.textContent = MONTH_NAMES[viewMonth];
    yearLabel.textContent = viewYear;
    grid.innerHTML = '';

    const firstDay = new Date(viewYear, viewMonth, 1).getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

    for (let i = 0; i < firstDay; i++) {
      const filler = document.createElement('div');
      filler.className = 'day-cell empty';
      grid.appendChild(filler);
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const k = keyFor(viewYear, viewMonth, d);
      const goals = data[k] || [];
      const isToday = viewYear === today.getFullYear() && viewMonth === today.getMonth() && d === today.getDate();

      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'day-cell' + (isToday ? ' is-today' : '');
      cell.setAttribute('aria-label', MONTH_NAMES[viewMonth] + ' ' + d + ', ' + goals.length + ' goal' + (goals.length === 1 ? '' : 's'));

      const num = document.createElement('div');
      num.className = 'day-num';
      num.textContent = d;
      cell.appendChild(num);

      if (goals.length) {
        const preview = document.createElement('div');
        preview.className = 'goal-preview';
        goals.slice(0, 3).forEach(g => {
          const span = document.createElement('span');
          span.className = 'pv-item' + (g.done ? ' done' : '');
          span.textContent = g.text;
          preview.appendChild(span);
        });
        cell.appendChild(preview);

        const count = document.createElement('div');
        const doneCount = goals.filter(g => g.done).length;
        count.className = 'goal-count';
        count.textContent = doneCount + ' / ' + goals.length + ' done';
        cell.appendChild(count);
      }

      cell.addEventListener('click', () => openDay(viewYear, viewMonth, d));
      grid.appendChild(cell);
    }
  }

  function openDay(y, m, d) {
    activeKey = keyFor(y, m, d);
    const dateObj = new Date(y, m, d);
    panelDate.textContent = WEEKDAY_FULL[dateObj.getDay()] + ', ' + MONTH_NAMES[m] + ' ' + d;
    renderGoalList();
    overlay.classList.add('open');
    addInput.value = '';
    setTimeout(() => addInput.focus(), 50);
  }

  function closeDay() {
    overlay.classList.remove('open');
    activeKey = null;
    render();
  }

  function renderGoalList() {
    goalList.innerHTML = '';
    const goals = data[activeKey] || [];

    if (!goals.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No goals yet for this day.';
      goalList.appendChild(empty);
      return;
    }

    goals.forEach((g, idx) => {
      const row = document.createElement('div');
      row.className = 'goal-row';

      const toggle = document.createElement('button');
      toggle.className = 'goal-toggle' + (g.done ? ' checked' : '');
      toggle.type = 'button';
      toggle.setAttribute('aria-label', g.done ? 'Mark as not done' : 'Mark as done');
      toggle.innerHTML = g.done ? '&#10003;' : '';
      toggle.addEventListener('click', () => {
        g.done = !g.done;
        scheduleSave();
        renderGoalList();
      });

      const text = document.createElement('div');
      text.className = 'goal-text' + (g.done ? ' done' : '');
      text.textContent = g.text;

      const remove = document.createElement('button');
      remove.className = 'goal-remove';
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove goal');
      remove.innerHTML = '&#10005;';
      remove.addEventListener('click', () => {
        goals.splice(idx, 1);
        scheduleSave();
        renderGoalList();
      });

      row.appendChild(toggle);
      row.appendChild(text);
      row.appendChild(remove);
      goalList.appendChild(row);
    });
  }

  function addGoal() {
    const text = addInput.value.trim();
    if (!text || !activeKey) return;
    if (!data[activeKey]) data[activeKey] = [];
    data[activeKey].push({ text: text, done: false });
    scheduleSave();
    addInput.value = '';
    renderGoalList();
    addInput.focus();
  }

  document.getElementById('addBtn').addEventListener('click', addGoal);
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addGoal();
  });

  document.getElementById('closeBtn').addEventListener('click', closeDay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDay();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeDay();
  });

  document.getElementById('prevBtn').addEventListener('click', () => {
    viewMonth--;
    if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    render();
  });
  document.getElementById('nextBtn').addEventListener('click', () => {
    viewMonth++;
    if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    render();
  });
  document.getElementById('todayBtn').addEventListener('click', () => {
    viewYear = today.getFullYear();
    viewMonth = today.getMonth();
    render();
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });

  (async function start() {
    try {
      const meRes = await fetch('/api/me');
      const me = await meRes.json();
      if (!me.signedIn) {
        window.location.href = '/login.html';
        return;
      }
      document.getElementById('accountLabel').textContent = 'Signed in as ' + (me.name || me.email);

      const goalsRes = await fetch('/api/goals');
      if (goalsRes.status === 401) {
        window.location.href = '/login.html';
        return;
      }
      const body = await goalsRes.json();
      data = body.goals || {};
    } catch (e) {
      console.error('Could not load goals', e);
    }
    document.getElementById('loadingState').style.display = 'none';
    document.getElementById('weekdaysRow').style.display = 'grid';
    render();
  })();
})();
