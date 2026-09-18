(function () {
  const CATEGORIES = [
    { id: 'work', name: 'Work', color: '#5B7A6B' },
    { id: 'personal', name: 'Personal', color: '#B5652C' },
    { id: 'academic', name: 'Academic', color: '#4C6FA6' },
    { id: 'athletic', name: 'Athletic', color: '#3F8F5E' },
    { id: 'extracurricular', name: 'Extracurricular', color: '#8A5BA6' },
    { id: 'club', name: 'Club', color: '#A65B7A' },
    { id: 'musical', name: 'Musical', color: '#A69B3F' },
    { id: 'performance', name: 'Performance', color: '#3F9BA6' },
    { id: 'other', name: 'Other', color: '#7A7A72' }
  ];
  const categoryById = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

  const SETTINGS_KEY = 'goalkeepr-settings';
  let settings = { theme: 'system', weekStart: 0 };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) settings = Object.assign(settings, JSON.parse(raw));
  } catch (e) { /* use defaults */ }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  function applyTheme() {
    if (settings.theme === 'light' || settings.theme === 'dark') {
      document.documentElement.setAttribute('data-theme', settings.theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }
  applyTheme();

  let data = {};
  let saveTimer = null;
  let categoryFilter = null; // null = show all
  let starPickerValue = 0;

  function pad2(n) { return String(n).padStart(2, '0'); }
  function keyFor(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }
  function keyForDate(dateObj) { return keyFor(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()); }
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
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
        if (res.status === 401) window.location.href = '/login.html';
      } catch (e) {
        console.error('Could not save goals', e);
      }
    }, 300);
  }

  const today = new Date();
  let viewYear = today.getFullYear();
  let viewMonth = today.getMonth();
  let selectedDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const WEEKDAY_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const WEEKDAY_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  // ---------- elements ----------
  const monthLabel = document.getElementById('monthLabel');
  const yearLabel = document.getElementById('yearLabel');
  const grid = document.getElementById('grid');
  const weekdaysRow = document.getElementById('weekdaysRow');
  const categoryListEl = document.getElementById('categoryList');
  const sidebarDayLabel = document.getElementById('sidebarDayLabel');
  const sidebarGoalList = document.getElementById('sidebarGoalList');
  const sidebarCategorySelect = document.getElementById('sidebarCategorySelect');
  const sidebarStarPicker = document.getElementById('sidebarStarPicker');
  const sidebarAddInput = document.getElementById('sidebarAddInput');

  // ---------- category sidebar list ----------
  function renderCategoryList() {
    categoryListEl.innerHTML = '';

    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'category-chip' + (categoryFilter === null ? ' active' : '');
    allBtn.innerHTML = '<span class="category-dot" style="background:var(--ink-soft)"></span><span>All goals</span>';
    allBtn.addEventListener('click', () => { categoryFilter = null; renderCategoryList(); renderSidebarGoals(); renderCalendar(); });
    categoryListEl.appendChild(allBtn);

    CATEGORIES.forEach(cat => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'category-chip' + (categoryFilter === cat.id ? ' active' : '');
      btn.innerHTML = '<span class="category-dot" style="background:' + cat.color + '"></span><span>' + cat.name + '</span>';
      btn.addEventListener('click', () => {
        categoryFilter = (categoryFilter === cat.id) ? null : cat.id;
        renderCategoryList();
        renderSidebarGoals();
        renderCalendar();
      });
      categoryListEl.appendChild(btn);
    });
  }

  // populate the add-goal category dropdown once
  CATEGORIES.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat.id;
    opt.textContent = cat.name;
    sidebarCategorySelect.appendChild(opt);
  });

  sidebarStarPicker.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = Number(btn.dataset.star);
      starPickerValue = (starPickerValue === val) ? 0 : val;
      renderStarPicker();
    });
  });

  function renderStarPicker() {
    sidebarStarPicker.querySelectorAll('button').forEach(btn => {
      const val = Number(btn.dataset.star);
      btn.classList.toggle('filled', val <= starPickerValue);
    });
  }

  function starsHtml(n) {
    if (!n) return '';
    return '&#9733;'.repeat(n);
  }

  function goalsForDay(dateObj, applyFilter) {
    const list = data[keyForDate(dateObj)] || [];
    if (applyFilter && categoryFilter) {
      return list.filter(g => g.category === categoryFilter);
    }
    return list;
  }

  // ---------- sidebar today/day panel ----------
  function renderSidebarHead() {
    const isToday = sameDay(selectedDay, today);
    sidebarDayLabel.textContent = isToday
      ? 'Today'
      : WEEKDAY_FULL[selectedDay.getDay()] + ', ' + MONTH_NAMES[selectedDay.getMonth()] + ' ' + selectedDay.getDate();
  }

  function renderSidebarGoals() {
    renderSidebarHead();
    sidebarGoalList.innerHTML = '';
    const k = keyForDate(selectedDay);
    const fullList = data[k] || [];
    const list = categoryFilter ? fullList.filter(g => g.category === categoryFilter) : fullList;

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = fullList.length ? 'No goals in this category for this day.' : 'No goals yet for this day.';
      sidebarGoalList.appendChild(empty);
      return;
    }

    list.forEach(g => {
      const row = document.createElement('div');
      row.className = 'sidebar-goal-row';

      const toggle = document.createElement('button');
      toggle.className = 'goal-toggle' + (g.done ? ' checked' : '');
      toggle.type = 'button';
      toggle.innerHTML = g.done ? '&#10003;' : '';
      toggle.addEventListener('click', () => {
        g.done = !g.done;
        scheduleSave();
        renderSidebarGoals();
        renderCalendar();
      });

      const main = document.createElement('div');
      main.className = 'sidebar-goal-main';

      const text = document.createElement('div');
      text.className = 'sidebar-goal-text' + (g.done ? ' done' : '');
      text.textContent = g.text;
      main.appendChild(text);

      const meta = document.createElement('div');
      meta.className = 'sidebar-goal-meta';
      const cat = categoryById[g.category] || categoryById.other;
      const tag = document.createElement('span');
      tag.className = 'mini-category-tag';
      tag.style.background = cat.color;
      tag.textContent = cat.name;
      meta.appendChild(tag);
      if (g.stars) {
        const stars = document.createElement('span');
        stars.className = 'mini-stars';
        stars.innerHTML = starsHtml(g.stars);
        meta.appendChild(stars);
      }
      main.appendChild(meta);

      const remove = document.createElement('button');
      remove.className = 'goal-remove';
      remove.type = 'button';
      remove.innerHTML = '&#10005;';
      remove.addEventListener('click', () => {
        const idx = fullList.indexOf(g);
        if (idx > -1) fullList.splice(idx, 1);
        scheduleSave();
        renderSidebarGoals();
        renderCalendar();
      });

      row.appendChild(toggle);
      row.appendChild(main);
      row.appendChild(remove);
      sidebarGoalList.appendChild(row);
    });
  }

  function addGoalToSelectedDay() {
    const text = sidebarAddInput.value.trim();
    if (!text) return;
    const k = keyForDate(selectedDay);
    if (!data[k]) data[k] = [];
    data[k].push({
      id: 'g_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      text: text,
      done: false,
      category: sidebarCategorySelect.value || 'other',
      stars: starPickerValue
    });
    scheduleSave();
    sidebarAddInput.value = '';
    starPickerValue = 0;
    renderStarPicker();
    renderSidebarGoals();
    renderCalendar();
  }

  document.getElementById('sidebarAddForm').addEventListener('submit', (e) => {
    e.preventDefault();
    addGoalToSelectedDay();
  });

  function shiftSelectedDay(deltaDays) {
    const next = new Date(selectedDay);
    next.setDate(next.getDate() + deltaDays);
    selectedDay = next;
    if (selectedDay.getFullYear() !== viewYear || selectedDay.getMonth() !== viewMonth) {
      viewYear = selectedDay.getFullYear();
      viewMonth = selectedDay.getMonth();
    }
    renderCalendar();
    renderSidebarGoals();
  }

  document.getElementById('sidebarPrevDay').addEventListener('click', () => shiftSelectedDay(-1));
  document.getElementById('sidebarNextDay').addEventListener('click', () => shiftSelectedDay(1));
  document.getElementById('sidebarJumpToday').addEventListener('click', () => {
    selectedDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    viewYear = today.getFullYear();
    viewMonth = today.getMonth();
    renderCalendar();
    renderSidebarGoals();
  });

  // ---------- calendar ----------
  function renderWeekdaysRow() {
    weekdaysRow.innerHTML = '';
    for (let i = 0; i < 7; i++) {
      const idx = (settings.weekStart + i) % 7;
      const div = document.createElement('div');
      div.textContent = WEEKDAY_SHORT[idx];
      weekdaysRow.appendChild(div);
    }
  }

  function renderCalendar() {
    monthLabel.textContent = MONTH_NAMES[viewMonth];
    yearLabel.textContent = viewYear;
    renderWeekdaysRow();
    grid.innerHTML = '';

    const jsFirstDay = new Date(viewYear, viewMonth, 1).getDay();
    const firstDayOffset = (jsFirstDay - settings.weekStart + 7) % 7;
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const now = new Date();

    for (let i = 0; i < firstDayOffset; i++) {
      const filler = document.createElement('div');
      filler.className = 'day-cell empty';
      grid.appendChild(filler);
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const cellDate = new Date(viewYear, viewMonth, d);
      const k = keyForDate(cellDate);
      const goals = categoryFilter ? (data[k] || []).filter(g => g.category === categoryFilter) : (data[k] || []);
      const isToday = sameDay(cellDate, now);
      const isSelected = sameDay(cellDate, selectedDay);

      const cell = document.createElement('button');
      cell.type = 'button';
      let cls = 'day-cell';
      if (isToday) cls += ' is-today';
      if (isSelected) cls += ' is-selected';
      cell.className = cls;
      cell.setAttribute('aria-label', MONTH_NAMES[viewMonth] + ' ' + d + ', ' + goals.length + ' goal' + (goals.length === 1 ? '' : 's'));

      const num = document.createElement('div');
      num.className = 'day-num';
      num.textContent = d;
      cell.appendChild(num);

      if (goals.length) {
        const preview = document.createElement('div');
        preview.className = 'goal-preview';
        goals.slice(0, 2).forEach(g => {
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

      cell.addEventListener('click', () => {
        selectedDay = cellDate;
        renderCalendar();
        renderSidebarGoals();
      });
      grid.appendChild(cell);
    }
  }

  document.getElementById('prevBtn').addEventListener('click', () => {
    viewMonth--;
    if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    renderCalendar();
  });
  document.getElementById('nextBtn').addEventListener('click', () => {
    viewMonth++;
    if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    renderCalendar();
  });
  document.getElementById('todayBtn').addEventListener('click', () => {
    viewYear = today.getFullYear();
    viewMonth = today.getMonth();
    renderCalendar();
  });

  // ---------- settings drawer ----------
  const drawer = document.getElementById('settingsDrawer');
  const drawerOverlay = document.getElementById('drawerOverlay');

  function openDrawer() {
    drawer.classList.add('open');
    drawerOverlay.classList.add('open');
  }
  function closeDrawer() {
    drawer.classList.remove('open');
    drawerOverlay.classList.remove('open');
  }
  document.getElementById('gearBtn').addEventListener('click', openDrawer);
  document.getElementById('closeDrawerBtn').addEventListener('click', closeDrawer);
  drawerOverlay.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  function renderSettingUI() {
    document.querySelectorAll('#themeOptions .option-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.themeValue === settings.theme);
    });
    document.querySelectorAll('#weekStartOptions .option-btn').forEach(btn => {
      btn.classList.toggle('active', Number(btn.dataset.weekValue) === settings.weekStart);
    });
  }

  document.querySelectorAll('#themeOptions .option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.theme = btn.dataset.themeValue;
      applyTheme();
      saveSettings();
      renderSettingUI();
    });
  });
  document.querySelectorAll('#weekStartOptions .option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.weekStart = Number(btn.dataset.weekValue);
      saveSettings();
      renderSettingUI();
      renderCalendar();
    });
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });

  // ---------- startup ----------
  (async function start() {
    try {
      const meRes = await fetch('/api/me');
      const me = await meRes.json();
      if (!me.signedIn) { window.location.href = '/login.html'; return; }
      document.getElementById('accountLabel').textContent = 'Signed in as ' + (me.name || me.email);

      const goalsRes = await fetch('/api/goals');
      if (goalsRes.status === 401) { window.location.href = '/login.html'; return; }
      const body = await goalsRes.json();
      data = body.goals || {};
    } catch (e) {
      console.error('Could not load goals', e);
    }

    document.getElementById('loadingState').style.display = 'none';
    weekdaysRow.style.display = 'grid';

    renderSettingUI();
    renderCategoryList();
    renderStarPicker();
    renderCalendar();
    renderSidebarGoals();
  })();
})();
