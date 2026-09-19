(function () {
  const CATEGORIES = [
    { id: 'academic', name: 'Academic', color: '#3355FF' },
    { id: 'athletic', name: 'Athletic', color: '#0FBB63' },
    { id: 'extracurricular', name: 'Extracurricular', color: '#8B3FF2' },
    { id: 'personal', name: 'Personal', color: '#FF7A17' }
  ];
  const SWATCHES = ['#3355FF', '#0FBB63', '#8B3FF2', '#FF7A17', '#F23F7A', '#08B5D6', '#E5342E', '#D6B60A'];

  let customCategories = [];

  function allCategories() { return CATEGORIES.concat(customCategories); }
  // Returns null when the id doesn't resolve to a real category (e.g. the
  // category was later removed) — callers decide whether to show nothing.
  function findCategory(id) { return allCategories().find(c => c.id === id) || null; }

  const SETTINGS_KEY = 'goalkeepr-settings';
  let settings = {
    theme: 'system',
    weekStart: 0,
    sortMode: 'significance',
    showCategories: true,
    showSignificance: true,
    sidebarCollapsed: false
  };
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
  let selectedCategoryId = null;

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
        data.__categories = customCategories;
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
  const sidebarStarPicker = document.getElementById('sidebarStarPicker');
  const sidebarAddInput = document.getElementById('sidebarAddInput');

  // ---------- category sidebar list (compact chips) ----------
  function setChipColors(el, color, active) {
    if (active) {
      el.style.background = color;
      el.style.borderColor = color;
      el.style.color = '#fff';
    } else {
      el.style.background = '';
      el.style.borderColor = '';
      el.style.color = '';
    }
  }

  function renderCategoryList() {
    categoryListEl.innerHTML = '';

    const allChip = document.createElement('button');
    allChip.type = 'button';
    allChip.className = 'category-chip' + (categoryFilter === null ? ' active' : '');
    allChip.innerHTML = '<span class="category-dot" style="background:currentColor"></span><span>All</span>';
    setChipColors(allChip, 'var(--primary)', categoryFilter === null);
    if (categoryFilter === null) { allChip.style.background = 'var(--primary)'; allChip.style.borderColor = 'var(--primary)'; }
    allChip.addEventListener('click', () => { categoryFilter = null; renderCategoryList(); renderSidebarGoals(); renderCalendar(); });
    categoryListEl.appendChild(allChip);

    allCategories().forEach(cat => {
      const wrap = document.createElement('span');
      wrap.className = 'category-chip' + (categoryFilter === cat.id ? ' active' : '');
      setChipColors(wrap, cat.color, categoryFilter === cat.id);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip-select';
      btn.innerHTML = '<span class="category-dot" style="background:' + (categoryFilter === cat.id ? '#fff' : cat.color) + '"></span><span>' + cat.name + '</span>';
      btn.addEventListener('click', () => {
        categoryFilter = (categoryFilter === cat.id) ? null : cat.id;
        renderCategoryList();
        renderSidebarGoals();
        renderCalendar();
      });
      wrap.appendChild(btn);

      const isCustom = customCategories.some(c => c.id === cat.id);
      if (isCustom) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'chip-remove';
        remove.setAttribute('aria-label', 'Remove ' + cat.name + ' category');
        remove.innerHTML = '&#10005;';
        remove.addEventListener('click', (e) => {
          e.stopPropagation();
          customCategories = customCategories.filter(c => c.id !== cat.id);
          if (categoryFilter === cat.id) categoryFilter = null;
          scheduleSave();
          renderCategoryList();
          renderSidebarGoals();
          renderCalendar();
          renderCategoryDropdown();
        });
        wrap.appendChild(remove);
      }

      categoryListEl.appendChild(wrap);
    });

    const addChip = document.createElement('button');
    addChip.type = 'button';
    addChip.className = 'category-chip category-add-chip';
    addChip.textContent = '+ Add';
    addChip.addEventListener('click', () => {
      const form = document.getElementById('categoryAddForm');
      form.hidden = !form.hidden;
      if (!form.hidden) document.getElementById('categoryAddInput').focus();
    });
    categoryListEl.appendChild(addChip);
  }

  // ---------- custom category creation ----------
  const categoryAddForm = document.getElementById('categoryAddForm');
  const categoryAddInput = document.getElementById('categoryAddInput');
  const swatchRow = document.getElementById('swatchRow');
  let swatchPick = SWATCHES[0];

  const customColorInput = document.getElementById('customColorInput');
  const rainbowSwatchBtn = document.getElementById('rainbowSwatchBtn');
  let customColorPicked = false;

  function renderSwatchRow() {
    swatchRow.innerHTML = '';
    SWATCHES.forEach(color => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch-btn' + (!customColorPicked && color === swatchPick ? ' selected' : '');
      b.style.background = color;
      b.setAttribute('aria-label', 'Choose color ' + color);
      b.addEventListener('click', () => {
        customColorPicked = false;
        swatchPick = color;
        renderSwatchRow();
      });
      swatchRow.appendChild(b);
    });
    rainbowSwatchBtn.classList.toggle('selected', customColorPicked);
    rainbowSwatchBtn.style.setProperty('--picked', customColorPicked ? swatchPick : 'transparent');
  }

  customColorInput.addEventListener('input', () => {
    customColorPicked = true;
    swatchPick = customColorInput.value;
    renderSwatchRow();
  });

  categoryAddForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = categoryAddInput.value.trim();
    if (!name) return;
    const id = 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    customCategories.push({ id, name, color: swatchPick });
    scheduleSave();
    categoryAddInput.value = '';
    customColorPicked = false;
    swatchPick = SWATCHES[customCategories.length % SWATCHES.length];
    renderSwatchRow();
    categoryAddForm.hidden = true;
    renderCategoryList();
    renderCategoryDropdown();
  });

  document.getElementById('categoryAddCancel').addEventListener('click', () => {
    categoryAddForm.hidden = true;
    categoryAddInput.value = '';
  });

  // ---------- custom category dropdown (add-goal form) ----------
  const cdTrigger = document.getElementById('cdTrigger');
  const cdMenu = document.getElementById('cdMenu');
  const cdDot = document.getElementById('cdDot');
  const cdLabel = document.getElementById('cdLabel');

  function setSelectedCategory(id) {
    const cat = findCategory(id) || allCategories()[0];
    selectedCategoryId = cat.id;
    cdDot.style.background = cat.color;
    cdLabel.textContent = cat.name;
  }

  function renderCategoryDropdown() {
    cdMenu.innerHTML = '';
    allCategories().forEach(cat => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'cd-option';
      opt.setAttribute('role', 'option');
      opt.innerHTML = '<span class="category-dot" style="background:' + cat.color + '"></span><span>' + cat.name + '</span>';
      opt.addEventListener('click', () => {
        setSelectedCategory(cat.id);
        closeCategoryDropdown();
      });
      cdMenu.appendChild(opt);
    });
    if (!selectedCategoryId || !allCategories().some(c => c.id === selectedCategoryId)) {
      setSelectedCategory(allCategories()[0].id);
    }
  }

  function openCategoryDropdown() {
    cdMenu.hidden = false;
    cdTrigger.setAttribute('aria-expanded', 'true');
  }
  function closeCategoryDropdown() {
    cdMenu.hidden = true;
    cdTrigger.setAttribute('aria-expanded', 'false');
  }
  cdTrigger.addEventListener('click', () => {
    if (cdMenu.hidden) openCategoryDropdown(); else closeCategoryDropdown();
  });
  document.addEventListener('click', (e) => {
    if (!document.getElementById('categoryDropdown').contains(e.target)) closeCategoryDropdown();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCategoryDropdown();
  });

  sidebarStarPicker.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = Number(btn.dataset.star);
      starPickerValue = (starPickerValue === val) ? 0 : val;
      renderStarPicker();
    });
    btn.addEventListener('mouseenter', () => previewStarPicker(Number(btn.dataset.star)));
  });
  sidebarStarPicker.addEventListener('mouseleave', renderStarPicker);

  function renderStarPicker() {
    sidebarStarPicker.querySelectorAll('button').forEach(btn => {
      const val = Number(btn.dataset.star);
      btn.classList.remove('preview');
      btn.classList.toggle('filled', val <= starPickerValue);
    });
  }

  // Ghost-fills stars up to the hovered one, without committing the value.
  function previewStarPicker(hoverVal) {
    sidebarStarPicker.querySelectorAll('button').forEach(btn => {
      const val = Number(btn.dataset.star);
      btn.classList.remove('filled');
      btn.classList.toggle('preview', val <= hoverVal);
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

  // ---------- sorting & manual reordering ----------
  function categoryRank(id) {
    const idx = allCategories().findIndex(c => c.id === id);
    return idx === -1 ? allCategories().length : idx;
  }

  function sortGoals(list) {
    const withIndex = list.map((g, i) => ({ g, i }));
    if (settings.sortMode === 'significance') {
      withIndex.sort((a, b) => (b.g.stars || 0) - (a.g.stars || 0) || a.i - b.i);
    } else if (settings.sortMode === 'category') {
      withIndex.sort((a, b) => categoryRank(a.g.category) - categoryRank(b.g.category) || a.i - b.i);
    }
    // 'manual' keeps the underlying array order as-is
    return withIndex.map(x => x.g);
  }

  function moveGoal(fullList, goal, direction) {
    const idx = fullList.indexOf(goal);
    const swapIdx = idx + direction;
    if (idx === -1 || swapIdx < 0 || swapIdx >= fullList.length) return;
    const tmp = fullList[idx];
    fullList[idx] = fullList[swapIdx];
    fullList[swapIdx] = tmp;
    scheduleSave();
    renderSidebarGoals();
    renderCalendar();
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
    const filteredList = categoryFilter ? fullList.filter(g => g.category === categoryFilter) : fullList;
    const list = sortGoals(filteredList);
    const canReorder = settings.sortMode === 'manual' && !categoryFilter;

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = fullList.length ? 'No goals in this category for this day.' : 'No goals yet for this day.';
      sidebarGoalList.appendChild(empty);
      return;
    }

    list.forEach((g, displayIdx) => {
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
      if (settings.showCategories) {
        const cat = findCategory(g.category);
        if (cat) {
          const tag = document.createElement('span');
          tag.className = 'mini-category-tag';
          tag.style.background = cat.color;
          tag.textContent = cat.name;
          meta.appendChild(tag);
        }
      }
      if (settings.showSignificance && g.stars) {
        const stars = document.createElement('span');
        stars.className = 'mini-stars';
        stars.innerHTML = starsHtml(g.stars);
        meta.appendChild(stars);
      }
      if (meta.childNodes.length) main.appendChild(meta);

      row.appendChild(toggle);
      row.appendChild(main);

      if (canReorder) {
        const reorderWrap = document.createElement('div');
        reorderWrap.className = 'goal-reorder';

        const up = document.createElement('button');
        up.type = 'button';
        up.className = 'reorder-btn';
        up.innerHTML = '&#9650;';
        up.setAttribute('aria-label', 'Move up');
        up.disabled = displayIdx === 0;
        up.addEventListener('click', () => moveGoal(fullList, g, -1));

        const down = document.createElement('button');
        down.type = 'button';
        down.className = 'reorder-btn';
        down.innerHTML = '&#9660;';
        down.setAttribute('aria-label', 'Move down');
        down.disabled = displayIdx === list.length - 1;
        down.addEventListener('click', () => moveGoal(fullList, g, 1));

        reorderWrap.appendChild(up);
        reorderWrap.appendChild(down);
        row.appendChild(reorderWrap);
      }

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
      category: selectedCategoryId || allCategories()[0].id,
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
        sortGoals(goals).slice(0, 2).forEach(g => {
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
    document.querySelectorAll('#sortModeOptions .option-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sortValue === settings.sortMode);
    });
    document.querySelectorAll('#showCategoriesOptions .option-btn').forEach(btn => {
      btn.classList.toggle('active', (btn.dataset.boolValue === 'true') === settings.showCategories);
    });
    document.querySelectorAll('#showSignificanceOptions .option-btn').forEach(btn => {
      btn.classList.toggle('active', (btn.dataset.boolValue === 'true') === settings.showSignificance);
    });
  }

  function applyVisibilitySettings() {
    document.getElementById('categoriesBlock').style.display = settings.showCategories ? '' : 'none';
    document.getElementById('categoryDropdown').style.display = settings.showCategories ? '' : 'none';
    document.getElementById('significanceGroup').style.display = settings.showSignificance ? '' : 'none';
    if (!settings.showCategories && categoryFilter !== null) {
      categoryFilter = null;
    }
  }

  function applySidebarCollapsed() {
    document.getElementById('sidebar').classList.toggle('is-collapsed', settings.sidebarCollapsed);
    const btn = document.getElementById('sidebarCollapseBtn');
    btn.setAttribute('aria-label', settings.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar');
    btn.title = settings.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
  }

  document.getElementById('sidebarCollapseBtn').addEventListener('click', () => {
    settings.sidebarCollapsed = !settings.sidebarCollapsed;
    saveSettings();
    applySidebarCollapsed();
  });

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
  document.querySelectorAll('#sortModeOptions .option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.sortMode = btn.dataset.sortValue;
      saveSettings();
      renderSettingUI();
      renderSidebarGoals();
      renderCalendar();
    });
  });
  document.querySelectorAll('#showCategoriesOptions .option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.showCategories = btn.dataset.boolValue === 'true';
      saveSettings();
      renderSettingUI();
      applyVisibilitySettings();
      renderCategoryList();
      renderSidebarGoals();
    });
  });
  document.querySelectorAll('#showSignificanceOptions .option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.showSignificance = btn.dataset.boolValue === 'true';
      saveSettings();
      renderSettingUI();
      applyVisibilitySettings();
      renderSidebarGoals();
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
      customCategories = Array.isArray(data.__categories) ? data.__categories : [];
    } catch (e) {
      console.error('Could not load goals', e);
    }

    document.getElementById('loadingState').style.display = 'none';
    weekdaysRow.style.display = 'grid';

    swatchPick = SWATCHES[customCategories.length % SWATCHES.length];
    renderSwatchRow();
    renderSettingUI();
    applyVisibilitySettings();
    applySidebarCollapsed();
    renderCategoryList();
    renderCategoryDropdown();
    renderStarPicker();
    renderCalendar();
    renderSidebarGoals();
  })();
})();
