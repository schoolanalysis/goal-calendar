(function () {
  // "Any" is a permanent, non-removable pseudo-category for goals that
  // deliberately don't fit a specific one — distinct from the display
  // fallback for a goal whose category was later deleted (findCategory
  // returns null there, and no tag is shown at all).
  const ANY_CATEGORY = { id: 'any', name: 'Any', color: '#9AA3B2' };
  // Seeded into a brand-new account's category list on first load only.
  // After that, the stored list (which the user can freely add to or
  // delete from, defaults included) is the source of truth.
  const DEFAULT_CATEGORIES = [
    { id: 'academic', name: 'Academic', color: '#3355FF' },
    { id: 'athletic', name: 'Athletic', color: '#0FBB63' },
    { id: 'extracurricular', name: 'Extracurricular', color: '#8B3FF2' },
    { id: 'personal', name: 'Personal', color: '#FF7A17' }
  ];
  const SWATCHES = ['#3355FF', '#0FBB63', '#8B3FF2', '#FF7A17', '#F23F7A', '#08B5D6', '#E5342E', '#D6B60A'];
  // Max category dots shown in a calendar day-cell footer before folding
  // the rest into a "+N" indicator, keeping the row from ever wrapping.
  const DAY_DOTS_MAX = 4;

  let categories = [];

  function allCategories() { return [ANY_CATEGORY].concat(categories); }
  // Categories worth filtering by — excludes "Any", which isn't shown as
  // a filter chip since it carries no visible tag to filter toward.
  function filterableCategories() { return categories; }
  // Returns null when the id doesn't resolve to a real category (e.g. the
  // category was later removed) — callers decide whether to show nothing.
  // Also treated as "no tag" by display code for the id 'any' itself.
  function findCategory(id) { return allCategories().find(c => c.id === id) || null; }
  function displayCategory(id) {
    const cat = findCategory(id);
    return (cat && cat.id !== 'any') ? cat : null;
  }

  const SETTINGS_KEY = 'goalkeepr-settings';
  let settings = {
    theme: 'system',
    weekStart: 0,
    sortMode: 'category',
    showCategories: true,
    showSignificance: true,
    sidebarCollapsed: false,
    subgoalsEnabled: true,
    subgoalsAutoComplete: false,
    dayPreviewEnabled: true
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
  let previewDay = null; // date currently shown in the day-preview overlay, or null when closed
  let openSubgoalFormFor = null; // goal id whose inline "add subgoal" form is open, or null
  let justCompletedId = null; // goal/subgoal id to play a completion "pop" on, for one render pass
  let dpStarValue = 0;
  let dpCategoryId = null;

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
        data.__categories = categories;
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
  const gridViewport = document.getElementById('gridViewport');
  const weekdaysRow = document.getElementById('weekdaysRow');
  const categoryListEl = document.getElementById('categoryList');
  const sidebar = document.getElementById('sidebar');
  const sidebarDayLabel = document.getElementById('sidebarDayLabel');
  const sidebarGoalList = document.getElementById('sidebarGoalList');
  const sidebarStarPicker = document.getElementById('sidebarStarPicker');
  const sidebarAddInput = document.getElementById('sidebarAddInput');
  const dayPreview = document.getElementById('dayPreview');
  const dpDate = document.getElementById('dpDate');
  const dpCloseBtn = document.getElementById('dpCloseBtn');
  const dpGoalList = document.getElementById('dpGoalList');
  const dpAddForm = document.getElementById('dpAddForm');
  const dpAddInput = document.getElementById('dpAddInput');
  const dpCatPicker = document.getElementById('dpCatPicker');
  const dpStarPicker = document.getElementById('dpStarPicker');
  const dpSeeGoalsBtn = document.getElementById('dpSeeGoalsBtn');

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
    allChip.addEventListener('click', () => { categoryFilter = null; renderCategoryList(); renderSidebarGoals(); renderDayPreview(); renderCalendar(); });
    categoryListEl.appendChild(allChip);

    filterableCategories().forEach(cat => {
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
        renderDayPreview();
        renderCalendar();
      });
      wrap.appendChild(btn);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'chip-remove';
      remove.setAttribute('aria-label', 'Remove ' + cat.name + ' category');
      remove.innerHTML = '&#10005;';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        categories = categories.filter(c => c.id !== cat.id);
        if (categoryFilter === cat.id) categoryFilter = null;
        scheduleSave();
        renderCategoryList();
        renderSidebarGoals();
        renderDayPreview();
        renderCalendar();
        renderCategoryDropdown();
      });
      wrap.appendChild(remove);

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
    categories.push({ id, name, color: swatchPick });
    scheduleSave();
    categoryAddInput.value = '';
    customColorPicked = false;
    swatchPick = SWATCHES[categories.length % SWATCHES.length];
    renderSwatchRow();
    categoryAddForm.hidden = true;
    renderCategoryList();
    renderCategoryDropdown();
    renderDayPreview();
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

  // ---------- day-preview star picker (separate state from the sidebar's) ----------
  dpStarPicker.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = Number(btn.dataset.star);
      dpStarValue = (dpStarValue === val) ? 0 : val;
      renderDpStarPicker();
    });
    btn.addEventListener('mouseenter', () => previewDpStarPicker(Number(btn.dataset.star)));
  });
  dpStarPicker.addEventListener('mouseleave', renderDpStarPicker);

  function renderDpStarPicker() {
    dpStarPicker.querySelectorAll('button').forEach(btn => {
      const val = Number(btn.dataset.star);
      btn.classList.remove('preview');
      btn.classList.toggle('filled', val <= dpStarValue);
    });
  }

  function previewDpStarPicker(hoverVal) {
    dpStarPicker.querySelectorAll('button').forEach(btn => {
      const val = Number(btn.dataset.star);
      btn.classList.remove('filled');
      btn.classList.toggle('preview', val <= hoverVal);
    });
  }

  // ---------- day-preview category picker (colored dots only, no names) ----------
  function renderDpCatPicker() {
    if (!dpCategoryId || !allCategories().some(c => c.id === dpCategoryId)) {
      dpCategoryId = allCategories()[0].id;
    }
    dpCatPicker.innerHTML = '';
    allCategories().forEach(cat => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch-btn' + (dpCategoryId === cat.id ? ' selected' : '');
      b.style.background = cat.color;
      b.title = cat.name;
      b.setAttribute('aria-label', 'Category: ' + cat.name);
      b.addEventListener('click', () => {
        dpCategoryId = cat.id;
        renderDpCatPicker();
      });
      dpCatPicker.appendChild(b);
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

  // Buckets goals by category (ordered like the category list, unknown/
  // deleted categories last), each bucket sub-sorted by significance —
  // used by the "sort by category" view's headered grouping.
  function groupGoalsByCategory(list) {
    const order = [];
    const byCategory = new Map();
    list.forEach(g => {
      if (!byCategory.has(g.category)) { byCategory.set(g.category, []); order.push(g.category); }
      byCategory.get(g.category).push(g);
    });
    order.sort((a, b) => categoryRank(a) - categoryRank(b));
    return order.map(catId => ({
      category: findCategory(catId) || { id: catId, name: 'Uncategorized', color: '#9AA3B2' },
      goals: byCategory.get(catId).slice().sort((a, b) => (b.stars || 0) - (a.stars || 0))
    }));
  }

  function moveGoal(fullList, goal, direction) {
    const idx = fullList.indexOf(goal);
    const swapIdx = idx + direction;
    if (idx === -1 || swapIdx < 0 || swapIdx >= fullList.length) return;
    const tmp = fullList[idx];
    fullList[idx] = fullList[swapIdx];
    fullList[swapIdx] = tmp;
    scheduleSave();
    refreshAfterGoalChange();
  }

  // Re-renders every place a goal can currently be shown — the sidebar, the
  // day-preview overlay (a no-op while it's closed) and the calendar dots —
  // so a change made in one place is immediately reflected in the others.
  function refreshAfterGoalChange() {
    renderSidebarGoals();
    renderDayPreview();
    renderCalendar();
    justCompletedId = null;
  }

  // Re-focuses the inline "add subgoal" input after a re-render, if one is
  // open and happens to live inside the given freshly-rendered container.
  function focusOpenSubgoalInput(container) {
    if (!openSubgoalFormFor) return;
    const el = container.querySelector('.subgoal-add-input');
    if (el) el.focus();
  }

  // Builds one goal row, shared by the sidebar list and the day-preview
  // overlay's goal list, including its optional subgoal list and the
  // hover-revealed "+" button for adding a new subgoal.
  //   opts: { dotOnlyCategory, canReorder, list, displayIdx, onRefresh }
  function buildGoalRowEl(g, fullList, opts) {
    const row = document.createElement('div');
    row.className = 'sidebar-goal-row goal-row-hoverable';

    const toggle = document.createElement('button');
    toggle.className = 'goal-toggle' + (g.done ? ' checked' : '') + (justCompletedId === g.id ? ' pop' : '');
    toggle.type = 'button';
    toggle.innerHTML = g.done ? '&#10003;' : '';
    toggle.addEventListener('click', () => {
      g.done = !g.done;
      justCompletedId = g.done ? g.id : null;
      scheduleSave();
      opts.onRefresh();
    });

    const main = document.createElement('div');
    main.className = 'sidebar-goal-main';

    const text = document.createElement('div');
    text.className = 'sidebar-goal-text' + (g.done ? ' done' : '');
    text.textContent = g.text;
    main.appendChild(text);

    const meta = document.createElement('div');
    meta.className = 'sidebar-goal-meta';
    const cat = settings.showCategories ? displayCategory(g.category) : null;
    if (cat && !opts.dotOnlyCategory) {
      const tag = document.createElement('span');
      tag.className = 'mini-category-tag';
      tag.style.background = cat.color;
      tag.textContent = cat.name;
      meta.appendChild(tag);
    }
    if (settings.showSignificance && g.stars) {
      const stars = document.createElement('span');
      stars.className = 'mini-stars';
      stars.innerHTML = starsHtml(g.stars);
      meta.appendChild(stars);
    }
    if (meta.childNodes.length) main.appendChild(meta);

    if (settings.subgoalsEnabled && g.subgoals && g.subgoals.length) {
      const sgList = document.createElement('div');
      sgList.className = 'subgoal-list';
      g.subgoals.forEach(sg => {
        const sgRow = document.createElement('div');
        sgRow.className = 'subgoal-row';

        const sgToggle = document.createElement('button');
        sgToggle.type = 'button';
        sgToggle.className = 'subgoal-toggle' + (sg.done ? ' checked' : '') + (justCompletedId === sg.id ? ' pop' : '');
        sgToggle.innerHTML = sg.done ? '&#10003;' : '';
        sgToggle.addEventListener('click', () => {
          sg.done = !sg.done;
          let poppedId = sg.done ? sg.id : null;
          if (settings.subgoalsAutoComplete) {
            const wasParentDone = g.done;
            g.done = g.subgoals.every(s => s.done);
            // The whole goal just finished — celebrate that instead of the last subgoal.
            if (g.done && !wasParentDone) poppedId = g.id;
          }
          justCompletedId = poppedId;
          scheduleSave();
          opts.onRefresh();
        });

        const sgText = document.createElement('span');
        sgText.className = 'subgoal-text' + (sg.done ? ' done' : '');
        sgText.textContent = sg.text;

        const sgRemove = document.createElement('button');
        sgRemove.type = 'button';
        sgRemove.className = 'subgoal-remove';
        sgRemove.innerHTML = '&#10005;';
        sgRemove.addEventListener('click', () => {
          g.subgoals = g.subgoals.filter(s => s.id !== sg.id);
          scheduleSave();
          opts.onRefresh();
        });

        sgRow.appendChild(sgToggle);
        sgRow.appendChild(sgText);
        sgRow.appendChild(sgRemove);
        sgList.appendChild(sgRow);
      });
      main.appendChild(sgList);
    }

    if (settings.subgoalsEnabled && openSubgoalFormFor === g.id) {
      const miniForm = document.createElement('form');
      miniForm.className = 'subgoal-add-form';
      const miniInput = document.createElement('input');
      miniInput.type = 'text';
      miniInput.className = 'subgoal-add-input';
      miniInput.placeholder = 'Subgoal name';
      miniInput.maxLength = 120;
      miniForm.appendChild(miniInput);
      miniForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const t = miniInput.value.trim();
        openSubgoalFormFor = null;
        if (t) {
          if (!g.subgoals) g.subgoals = [];
          g.subgoals.push({ id: 'sg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), text: t, done: false });
          scheduleSave();
        }
        opts.onRefresh();
      });
      miniInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { openSubgoalFormFor = null; opts.onRefresh(); }
      });
      main.appendChild(miniForm);
    }

    row.appendChild(toggle);
    row.appendChild(main);

    function buildRemoveBtn() {
      const remove = document.createElement('button');
      remove.className = 'goal-remove';
      remove.type = 'button';
      remove.innerHTML = '&#10005;';
      remove.addEventListener('click', () => {
        const idx = fullList.indexOf(g);
        if (idx > -1) fullList.splice(idx, 1);
        scheduleSave();
        opts.onRefresh();
      });
      return remove;
    }

    function buildPlusBtn(className) {
      const plus = document.createElement('button');
      plus.type = 'button';
      plus.className = className;
      plus.setAttribute('aria-label', 'Add subgoal');
      plus.innerHTML = '&#43;';
      plus.addEventListener('click', (e) => {
        e.stopPropagation();
        openSubgoalFormFor = (openSubgoalFormFor === g.id) ? null : g.id;
        opts.onRefresh();
      });
      return plus;
    }

    if (opts.dotOnlyCategory) {
      // Compact layout: a trailing cluster of [dot, hover-only "+", "x"],
      // spaced with its own margins (not the row's gap) so the collapsed
      // "+" occupies no space — hovering expands it, pushing the dot left,
      // while "x" stays put.
      const cluster = document.createElement('div');
      cluster.className = 'goal-row-trailing';
      if (cat) {
        const dot = document.createElement('span');
        dot.className = 'category-dot goal-row-dot';
        dot.style.background = cat.color;
        dot.title = cat.name;
        cluster.appendChild(dot);
      }
      if (settings.subgoalsEnabled) cluster.appendChild(buildPlusBtn('compact-plus-btn'));
      const removeCompact = buildRemoveBtn();
      removeCompact.classList.add('goal-remove-compact');
      cluster.appendChild(removeCompact);
      row.appendChild(cluster);
    } else {
      if (settings.subgoalsEnabled) row.appendChild(buildPlusBtn('subgoal-add-btn'));

      if (opts.canReorder) {
        const reorderWrap = document.createElement('div');
        reorderWrap.className = 'goal-reorder';

        const up = document.createElement('button');
        up.type = 'button';
        up.className = 'reorder-btn';
        up.innerHTML = '&#9650;';
        up.setAttribute('aria-label', 'Move up');
        up.disabled = opts.displayIdx === 0;
        up.addEventListener('click', () => moveGoal(fullList, g, -1));

        const down = document.createElement('button');
        down.type = 'button';
        down.className = 'reorder-btn';
        down.innerHTML = '&#9660;';
        down.setAttribute('aria-label', 'Move down');
        down.disabled = opts.displayIdx === opts.list.length - 1;
        down.addEventListener('click', () => moveGoal(fullList, g, 1));

        reorderWrap.appendChild(up);
        reorderWrap.appendChild(down);
        row.appendChild(reorderWrap);
      }

      row.appendChild(buildRemoveBtn());
    }

    return row;
  }

  // ---------- sidebar today/day panel ----------
  function renderSidebarHead() {
    const isToday = sameDay(selectedDay, today);
    sidebarDayLabel.textContent = isToday
      ? 'Today'
      : WEEKDAY_FULL[selectedDay.getDay()] + ', ' + MONTH_NAMES[selectedDay.getMonth()] + ' ' + selectedDay.getDate();
  }

  // Renders a goal list into a container, either as a flat list (sorted by
  // significance or in manual order) or, in "sort by category" mode,
  // grouped under a header per category with each group sub-sorted by
  // significance — shared by the sidebar and the day-preview window.
  //   opts: { dotOnlyCategory, canReorder, onRefresh }
  function renderGoalListInto(container, fullList, filteredList, opts) {
    container.innerHTML = '';

    if (!filteredList.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = fullList.length ? 'No goals in this category for this day.' : 'No goals yet for this day.';
      container.appendChild(empty);
      return;
    }

    if (settings.sortMode === 'category') {
      const groups = groupGoalsByCategory(filteredList);
      // "Any" carries no meaningful tag, so it gets no header and sits
      // last instead of wherever it would otherwise rank.
      const anyIdx = groups.findIndex(gr => gr.category.id === 'any');
      if (anyIdx !== -1) groups.push(groups.splice(anyIdx, 1)[0]);

      groups.forEach(group => {
        if (opts.showCategoryHeaders && group.category.id !== 'any') {
          const header = document.createElement('div');
          header.className = 'goal-group-header';
          const dot = document.createElement('span');
          dot.className = 'category-dot';
          dot.style.background = group.category.color;
          dot.title = group.category.name;
          header.appendChild(dot);
          header.appendChild(document.createTextNode(group.category.name));
          container.appendChild(header);
        }

        group.goals.forEach(g => {
          container.appendChild(buildGoalRowEl(g, fullList, {
            dotOnlyCategory: true,
            canReorder: false,
            onRefresh: opts.onRefresh
          }));
        });
      });
    } else {
      const list = sortGoals(filteredList);
      list.forEach((g, displayIdx) => {
        container.appendChild(buildGoalRowEl(g, fullList, {
          dotOnlyCategory: opts.dotOnlyCategory,
          canReorder: opts.canReorder,
          list,
          displayIdx,
          onRefresh: opts.onRefresh
        }));
      });
    }
  }

  function renderSidebarGoals() {
    renderSidebarHead();
    const k = keyForDate(selectedDay);
    const fullList = data[k] || [];
    const filteredList = categoryFilter ? fullList.filter(g => g.category === categoryFilter) : fullList;
    const canReorder = settings.sortMode === 'manual' && !categoryFilter;

    renderGoalListInto(sidebarGoalList, fullList, filteredList, {
      dotOnlyCategory: false,
      canReorder,
      showCategoryHeaders: true,
      onRefresh: refreshAfterGoalChange
    });
    focusOpenSubgoalInput(sidebarGoalList);
  }

  // ---------- day-preview overlay (click a day → compact window anchored over it) ----------
  // Not a modal — there's no dimming overlay, so it sits centered on the
  // clicked cell (clamped to stay fully on-screen) while the rest of the
  // app stays usable underneath it.
  function anchoredPreviewRect(cellRect) {
    const width = Math.min(300, window.innerWidth - 24);
    const height = Math.min(380, window.innerHeight - 24);
    const margin = 12;
    const cellCenterX = cellRect.left + cellRect.width / 2;
    const cellCenterY = cellRect.top + cellRect.height / 2;
    let left = cellCenterX - width / 2;
    let top = cellCenterY - height / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
    return { top, left, width, height };
  }

  function renderDayPreview() {
    if (!previewDay) return;
    const isToday = sameDay(previewDay, today);
    dpDate.textContent = (isToday ? 'Today · ' : '') + WEEKDAY_FULL[previewDay.getDay()] + ', ' + MONTH_NAMES[previewDay.getMonth()] + ' ' + previewDay.getDate();

    const k = keyForDate(previewDay);
    const fullList = data[k] || [];
    const filteredList = categoryFilter ? fullList.filter(g => g.category === categoryFilter) : fullList;

    renderGoalListInto(dpGoalList, fullList, filteredList, {
      dotOnlyCategory: true,
      canReorder: false,
      showCategoryHeaders: false,
      onRefresh: refreshAfterGoalChange
    });
    focusOpenSubgoalInput(dpGoalList);
    renderDpCatPicker();
  }

  let morphTimer = null;

  function openDayPreview(cellDate, cellEl) {
    clearTimeout(morphTimer);
    dayPreview.classList.remove('morphing');
    previewDay = cellDate;
    renderDayPreview();

    const startRect = cellEl.getBoundingClientRect();
    dayPreview.style.transition = 'none';
    dayPreview.style.top = startRect.top + 'px';
    dayPreview.style.left = startRect.left + 'px';
    dayPreview.style.width = startRect.width + 'px';
    dayPreview.style.height = startRect.height + 'px';
    dayPreview.classList.add('open');

    // Force layout so the browser registers the starting rect before we
    // animate to the resting size — otherwise the two states collapse into
    // one and there's no "maximize" motion.
    void dayPreview.offsetWidth;

    dayPreview.style.transition = '';
    const rest = anchoredPreviewRect(startRect);
    dayPreview.style.top = rest.top + 'px';
    dayPreview.style.left = rest.left + 'px';
    dayPreview.style.width = rest.width + 'px';
    dayPreview.style.height = rest.height + 'px';
  }

  function closeDayPreview() {
    clearTimeout(morphTimer);
    dayPreview.classList.remove('open', 'morphing');
    openSubgoalFormFor = null;
  }

  dpCloseBtn.addEventListener('click', closeDayPreview);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDayPreview(); });

  // Animates the day-preview window sliding over onto the sidebar's own
  // position/size, fading as it lands, so it visually "becomes" the
  // sidebar rather than just closing. The sidebar itself isn't touched
  // until the window has completely finished traveling — onComplete runs
  // only once it's fully arrived and faded out.
  function morphDayPreviewIntoSidebar(onComplete) {
    const targetRect = sidebar.getBoundingClientRect();

    dayPreview.classList.add('morphing');
    dayPreview.style.top = targetRect.top + 'px';
    dayPreview.style.left = targetRect.left + 'px';
    dayPreview.style.width = targetRect.width + 'px';
    dayPreview.style.height = targetRect.height + 'px';
    dayPreview.style.opacity = '0';

    openSubgoalFormFor = null;
    clearTimeout(morphTimer);
    morphTimer = setTimeout(() => {
      dayPreview.classList.remove('open', 'morphing');
      dayPreview.removeAttribute('style');
      if (onComplete) onComplete();
    }, 190);
  }

  // The one moment the sidebar is allowed to jump to a different day: the
  // user explicitly asked to, via "See goals", closing the preview.
  dpSeeGoalsBtn.addEventListener('click', () => {
    if (!previewDay) return;
    const targetDay = previewDay;
    morphDayPreviewIntoSidebar(() => {
      selectedDay = targetDay;
      if (selectedDay.getFullYear() !== viewYear || selectedDay.getMonth() !== viewMonth) {
        viewYear = selectedDay.getFullYear();
        viewMonth = selectedDay.getMonth();
      }
      renderCalendar();
      renderSidebarGoals();
    });
  });

  dpAddForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = dpAddInput.value.trim();
    if (!text || !previewDay) return;
    const k = keyForDate(previewDay);
    if (!data[k]) data[k] = [];
    data[k].push({
      id: 'g_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      text: text,
      done: false,
      category: dpCategoryId || allCategories()[0].id,
      stars: dpStarValue
    });
    scheduleSave();
    dpAddInput.value = '';
    dpStarValue = 0;
    renderDpStarPicker();
    refreshAfterGoalChange();
  });

  // Closes an open inline "add subgoal" form when clicking anywhere else.
  document.addEventListener('click', (e) => {
    if (!openSubgoalFormFor) return;
    if (e.target.closest('.subgoal-add-form') || e.target.closest('.subgoal-add-btn')) return;
    openSubgoalFormFor = null;
    renderSidebarGoals();
    renderDayPreview();
  });

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
          const cat = settings.showCategories ? displayCategory(g.category) : null;
          if (cat) {
            const dot = document.createElement('span');
            dot.className = 'pv-dot';
            dot.style.background = cat.color;
            dot.title = cat.name;
            span.appendChild(dot);
          }
          span.appendChild(document.createTextNode(g.text));
          preview.appendChild(span);
        });
        cell.appendChild(preview);

        const footer = document.createElement('div');
        footer.className = 'day-cell-footer';

        const count = document.createElement('div');
        const doneCount = goals.filter(g => g.done).length;
        count.className = 'goal-count';
        count.textContent = doneCount + ' / ' + goals.length + ' done';
        footer.appendChild(count);

        if (settings.showCategories) {
          const dots = document.createElement('div');
          dots.className = 'day-dots';
          // Every goal gets a dot slot here, "Any" and a since-deleted
          // category included (in a neutral grey) — this cluster stands
          // in for the day's goal count, so it must always add up to
          // "goals.length", or a goal can silently vanish from it with no
          // "+N" to explain the gap.
          const dotCats = sortGoals(goals).map(g => findCategory(g.category) || { name: 'Uncategorized', color: '#9AA3B2' });
          // Cap to one row instead of letting dots wrap — a wrapped second
          // row grows the cell taller than its grid row expects and ends
          // up visually swallowed by the next row of cells underneath it.
          const shown = dotCats.length > DAY_DOTS_MAX ? dotCats.slice(0, DAY_DOTS_MAX - 1) : dotCats;
          shown.forEach(cat => {
            const dot = document.createElement('span');
            dot.className = 'day-dot';
            dot.style.background = cat.color;
            dot.title = cat.name;
            dots.appendChild(dot);
          });
          if (dotCats.length > shown.length) {
            const extra = dotCats.length - shown.length;
            const more = document.createElement('span');
            more.className = 'day-dot-more';
            more.textContent = '+' + extra;
            more.title = extra + ' more';
            dots.appendChild(more);
          }
          if (dots.childNodes.length) footer.appendChild(dots);
        }

        cell.appendChild(footer);
      }

      cell.addEventListener('click', () => {
        if (!settings.dayPreviewEnabled) {
          selectedDay = cellDate;
          renderCalendar();
          renderSidebarGoals();
          return;
        }
        // Clicking the day already open in the preview toggles it closed.
        if (dayPreview.classList.contains('open') && previewDay && sameDay(previewDay, cellDate)) {
          closeDayPreview();
          return;
        }
        openDayPreview(cellDate, cell);
      });
      grid.appendChild(cell);
    }
  }

  // Slides the grid to the next/previous month instead of an instant swap —
  // only used for the explicit prev/next arrows, not other re-renders.
  function navigateMonth(direction) {
    const oldClone = grid.cloneNode(true);
    oldClone.removeAttribute('id');
    oldClone.classList.add('grid-slide-clone');
    gridViewport.appendChild(oldClone);

    viewMonth += direction;
    if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    renderCalendar();

    const distance = 46;
    grid.style.transition = 'none';
    grid.style.transform = 'translateX(' + (direction > 0 ? distance : -distance) + 'px)';
    grid.style.opacity = '0';
    void grid.offsetWidth;
    grid.style.transition = '';

    requestAnimationFrame(() => {
      grid.style.transform = 'translateX(0)';
      grid.style.opacity = '1';
      oldClone.style.transform = 'translateX(' + (direction > 0 ? -distance : distance) + 'px)';
      oldClone.style.opacity = '0';
    });

    setTimeout(() => oldClone.remove(), 340);
  }

  document.getElementById('prevBtn').addEventListener('click', () => navigateMonth(-1));
  document.getElementById('nextBtn').addEventListener('click', () => navigateMonth(1));
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
    document.querySelectorAll('#subgoalsEnabledOptions .option-btn').forEach(btn => {
      btn.classList.toggle('active', (btn.dataset.boolValue === 'true') === settings.subgoalsEnabled);
    });
    document.querySelectorAll('#subgoalsAutoCompleteOptions .option-btn').forEach(btn => {
      btn.classList.toggle('active', (btn.dataset.boolValue === 'true') === settings.subgoalsAutoComplete);
    });
    document.querySelectorAll('#dayPreviewEnabledOptions .option-btn').forEach(btn => {
      btn.classList.toggle('active', (btn.dataset.boolValue === 'true') === settings.dayPreviewEnabled);
    });
  }

  function applyVisibilitySettings() {
    document.getElementById('categoriesBlock').style.display = settings.showCategories ? '' : 'none';
    document.getElementById('categoryDropdown').style.display = settings.showCategories ? '' : 'none';
    document.getElementById('significanceGroup').style.display = settings.showSignificance ? '' : 'none';
    dpCatPicker.style.display = settings.showCategories ? '' : 'none';
    dpStarPicker.style.display = settings.showSignificance ? '' : 'none';
    if (!settings.showCategories && categoryFilter !== null) {
      categoryFilter = null;
    }
  }

  function applySidebarCollapsed() {
    document.getElementById('sidebar').classList.toggle('is-collapsed', settings.sidebarCollapsed);
    const btn = document.getElementById('sidebarCollapseBtn');
    btn.classList.toggle('is-collapsed', settings.sidebarCollapsed);
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
      renderDayPreview();
    });
  });
  document.querySelectorAll('#showSignificanceOptions .option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.showSignificance = btn.dataset.boolValue === 'true';
      saveSettings();
      renderSettingUI();
      applyVisibilitySettings();
      renderSidebarGoals();
      renderDayPreview();
    });
  });
  document.querySelectorAll('#subgoalsEnabledOptions .option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.subgoalsEnabled = btn.dataset.boolValue === 'true';
      saveSettings();
      renderSettingUI();
      renderSidebarGoals();
      renderDayPreview();
    });
  });
  document.querySelectorAll('#subgoalsAutoCompleteOptions .option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.subgoalsAutoComplete = btn.dataset.boolValue === 'true';
      saveSettings();
      renderSettingUI();
    });
  });
  document.querySelectorAll('#dayPreviewEnabledOptions .option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.dayPreviewEnabled = btn.dataset.boolValue === 'true';
      saveSettings();
      renderSettingUI();
      if (!settings.dayPreviewEnabled) closeDayPreview();
    });
  });

  document.getElementById('restoreDefaultsBtn').addEventListener('click', () => {
    let restored = false;
    DEFAULT_CATEGORIES.forEach(def => {
      if (!categories.some(c => c.id === def.id)) {
        categories.push(Object.assign({}, def));
        restored = true;
      }
    });
    if (!restored) return;
    scheduleSave();
    renderCategoryList();
    renderCategoryDropdown();
    renderSidebarGoals();
    renderDayPreview();
    renderCalendar();
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
      // A brand-new account has no stored category list yet — seed it with
      // the defaults. Once saved, whatever's stored (additions, deletions,
      // built-ins included) is the source of truth from then on.
      categories = Array.isArray(data.__categories)
        ? data.__categories
        : DEFAULT_CATEGORIES.map(c => Object.assign({}, c));
    } catch (e) {
      console.error('Could not load goals', e);
    }

    document.getElementById('loadingState').style.display = 'none';
    weekdaysRow.style.display = 'grid';

    swatchPick = SWATCHES[categories.length % SWATCHES.length];
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
