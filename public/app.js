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
  // Resolves the most specific color+name for a goal: its subcategory's own
  // color/name when it has one that still exists, else its category's.
  // Returns null for "Any"/deleted categories, same as displayCategory.
  function goalDisplayInfo(g) {
    const cat = displayCategory(g.category);
    if (!cat) return null;
    const sub = settings.subcategoriesEnabled && g.subcategory && cat.subcategories && cat.subcategories.find(s => s.id === g.subcategory);
    return sub ? { color: sub.color || cat.color, name: sub.name } : { color: cat.color, name: cat.name };
  }
  // Same resolution as goalDisplayInfo, but never returns null — "Any" and
  // deleted categories fall back to a neutral grey instead of being
  // skipped, since the calendar's day-dot cluster needs one dot per goal.
  function goalDotInfo(g) {
    const cat = findCategory(g.category) || { name: 'Uncategorized', color: '#9AA3B2' };
    const sub = settings.subcategoriesEnabled && g.subcategory && cat.subcategories && cat.subcategories.find(s => s.id === g.subcategory);
    return sub ? { color: sub.color || cat.color, name: sub.name } : { color: cat.color, name: cat.name };
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
    dayPreviewEnabled: true,
    subcategoriesEnabled: true,
    repeatingEnabled: true
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
  let selectedSubcategoryId = null;
  let subcategoryFormFor = null; // category id whose inline "add subcategory" form is open, or null
  let expandedChipCategoryIds = new Set(); // category ids whose subcategory row is expanded in the sidebar
  // Keys of goal-list group/subgroup headers currently collapsed (goals
  // hidden) — 'cat:<id>' for a category, 'sub:<catId>:<subId>' for a
  // subcategory. Shared across the sidebar, day-preview, and "All goals",
  // so collapsing a category in one place collapses it everywhere.
  let collapsedGroups = new Set();
  let previewDay = null; // date currently shown in the day-preview overlay, or null when closed
  let openSubgoalFormFor = null; // goal id whose inline "add subgoal" form is open, or null
  let justCompletedId = null; // goal/subgoal id to play a completion "pop" on, for one render pass
  let dpStarValue = 0;
  let dpCategoryId = null;
  // Repeating-goal definitions (persisted as data.__series). Each one's
  // occurrences are stored as ordinary goals on their dates, tagged with
  // seriesId, so checking off, subgoals, filters and calendar dots all
  // work on them unchanged.
  let series = [];
  let repeatDraft = null; // repeat settings for the next goal added from the sidebar, or null for "once"
  // Time for the next goal added from the sidebar: { start: 'HH:MM', end: 'HH:MM' | null }, or null.
  // Goals store it as time / endTime (24-hour 'HH:MM', so plain string order is time order).
  let timeDraft = null;

  function pad2(n) { return String(n).padStart(2, '0'); }
  function keyFor(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }
  function keyForDate(dateObj) { return keyFor(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()); }
  // Real day entries, as opposed to metadata keys like __categories/__series.
  function isDateKey(k) { return /^\d{4}-\d{2}-\d{2}$/.test(k); }
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        data.__categories = categories;
        data.__series = series;
        const res = await fetch('/api/goals', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goals: data })
        });
        if (res.status === 401) window.location.href = '/login.html';
        else if (!res.ok) console.error('Could not save goals: HTTP ' + res.status);
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
  const WEEKDAY_TWO = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  const REPEAT_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>';
  const CLOCK_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  const REPEAT_FREQS = [
    { id: 'daily', label: 'Every day' },
    { id: 'alternate', label: 'Every other day' },
    { id: 'weekly', label: 'Every week' },
    { id: 'monthly', label: 'Every month' }
  ];
  const REPEAT_DURATIONS = [
    { id: '1w', label: '1 week' },
    { id: '1m', label: '1 month' },
    { id: '3m', label: '3 months' },
    { id: '6m', label: '6 months' },
    { id: 'custom', label: 'Until…' }
  ];
  // Occurrences are stored as real goals, so cap how far one repeat reaches.
  const REPEAT_MAX_DAYS = 366;

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
  const allGoalsBtn = document.getElementById('allGoalsBtn');
  const allGoalsOverlay = document.getElementById('allGoalsOverlay');
  const allGoalsModal = document.getElementById('allGoalsModal');
  const allGoalsCloseBtn = document.getElementById('allGoalsCloseBtn');
  const allGoalsCount = document.getElementById('allGoalsCount');
  const allGoalsBody = document.getElementById('allGoalsBody');

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
    allChip.addEventListener('click', () => { categoryFilter = null; renderCategoryList(); renderSidebarGoals(); renderDayPreview(); renderAllGoalsModal(); renderCalendar(); });
    categoryListEl.appendChild(allChip);

    filterableCategories().forEach(cat => {
      const wrap = document.createElement('span');
      wrap.className = 'category-chip' + (categoryFilter === cat.id ? ' active' : '');
      setChipColors(wrap, cat.color, categoryFilter === cat.id);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip-select';
      btn.innerHTML = '<span class="category-dot" style="background:' + (categoryFilter === cat.id ? '#fff' : cat.color) + '"></span><span>' + cat.name + '</span>';
      wrap.appendChild(btn);
      // On the whole row, not just the inner button: the row's padding
      // (over half its height) would otherwise be a dead zone that shows a
      // pointer cursor but ignores clicks. Expand/remove stop propagation.
      wrap.addEventListener('click', () => {
        categoryFilter = (categoryFilter === cat.id) ? null : cat.id;
        // While viewing one category, new goals default to it — otherwise
        // they'd be tagged with whatever the pickers last held and filtered
        // straight out of sight.
        if (categoryFilter) {
          if (selectedCategoryId !== cat.id) setSelectedCategory(cat.id, null);
          if (dpCategoryId !== cat.id) { dpCategoryId = cat.id; renderDpCatPicker(); }
        }
        renderCategoryList();
        renderSidebarGoals();
        renderDayPreview();
        renderAllGoalsModal();
        renderCalendar();
      });

      // Always visible — not hover-only — so subcategories are something a
      // student discovers just by looking, not a hidden trick they have to
      // be told about, and so it works the same with a finger as a mouse.
      const isExpanded = settings.subcategoriesEnabled && expandedChipCategoryIds.has(cat.id);
      if (settings.subcategoriesEnabled) {
        const expandBtn = document.createElement('button');
        expandBtn.type = 'button';
        expandBtn.className = 'chip-expand' + (isExpanded ? ' expanded' : '');
        expandBtn.setAttribute('aria-label', (isExpanded ? 'Hide' : 'Show') + ' ' + cat.name + ' subcategories');
        expandBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
        expandBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (isExpanded) expandedChipCategoryIds.delete(cat.id);
          else expandedChipCategoryIds.add(cat.id);
          renderCategoryList();
        });
        wrap.appendChild(expandBtn);
      }

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'chip-remove';
      remove.setAttribute('aria-label', 'Remove ' + cat.name + ' category');
      remove.innerHTML = '&#10005;';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        categories = categories.filter(c => c.id !== cat.id);
        if (categoryFilter === cat.id) categoryFilter = null;
        if (subcategoryFormFor === cat.id) subcategoryFormFor = null;
        expandedChipCategoryIds.delete(cat.id);
        scheduleSave();
        renderCategoryList();
        renderSidebarGoals();
        renderDayPreview();
        renderAllGoalsModal();
        renderCalendar();
        renderCategoryDropdown();
      });
      wrap.appendChild(remove);

      categoryListEl.appendChild(wrap);

      if (isExpanded) {
        const subRow = document.createElement('div');
        subRow.className = 'subcategory-row';

        (cat.subcategories || []).forEach(sub => {
          const subWrap = document.createElement('span');
          subWrap.className = 'subcategory-chip';
          const subDot = document.createElement('span');
          subDot.className = 'category-dot';
          subDot.style.background = sub.color || cat.color;
          subWrap.appendChild(subDot);
          subWrap.appendChild(document.createTextNode(sub.name));

          const subRemove = document.createElement('button');
          subRemove.type = 'button';
          subRemove.className = 'chip-remove';
          subRemove.setAttribute('aria-label', 'Remove ' + sub.name + ' subcategory');
          subRemove.innerHTML = '&#10005;';
          subRemove.addEventListener('click', () => {
            cat.subcategories = cat.subcategories.filter(s => s.id !== sub.id);
            scheduleSave();
            renderCategoryList();
            renderCategoryDropdown();
            renderSidebarGoals();
            renderDayPreview();
            renderAllGoalsModal();
            renderCalendar();
          });
          subWrap.appendChild(subRemove);

          subRow.appendChild(subWrap);
        });

        const addSubChip = document.createElement('button');
        addSubChip.type = 'button';
        addSubChip.className = 'subcategory-chip category-add-chip';
        addSubChip.textContent = '+ Add';
        addSubChip.addEventListener('click', () => {
          subcategoryFormFor = cat.id;
          openCategoryAddForm();
        });
        subRow.appendChild(addSubChip);

        categoryListEl.appendChild(subRow);
      }
    });

    const addChip = document.createElement('button');
    addChip.type = 'button';
    addChip.className = 'category-chip category-add-chip';
    addChip.textContent = '+ Add';
    addChip.addEventListener('click', () => {
      if (!categoryAddForm.hidden && !subcategoryFormFor) {
        categoryAddForm.hidden = true;
        return;
      }
      subcategoryFormFor = null;
      openCategoryAddForm();
    });
    categoryListEl.appendChild(addChip);
  }

  // Opens the shared add-category-or-subcategory form, labeling and
  // resetting it for whichever context subcategoryFormFor implies.
  function openCategoryAddForm() {
    const cat = subcategoryFormFor && categories.find(c => c.id === subcategoryFormFor);
    document.getElementById('categoryAddLabel').textContent = cat ? ('New subcategory for ' + cat.name) : 'New category';
    categoryAddInput.placeholder = cat ? 'Subcategory name' : 'Category name';
    categoryAddForm.hidden = false;
    categoryAddInput.value = '';
    customColorPicked = false;
    swatchPick = SWATCHES[(cat ? (cat.subcategories || []).length : categories.length) % SWATCHES.length];
    renderSwatchRow();
    categoryAddInput.focus();
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
    const cat = subcategoryFormFor && categories.find(c => c.id === subcategoryFormFor);
    if (cat) {
      if (!cat.subcategories) cat.subcategories = [];
      const id = 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      cat.subcategories.push({ id, name, color: swatchPick });
      expandedChipCategoryIds.add(cat.id);
    } else {
      const id = 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      categories.push({ id, name, color: swatchPick });
    }
    scheduleSave();
    categoryAddInput.value = '';
    customColorPicked = false;
    swatchPick = SWATCHES[categories.length % SWATCHES.length];
    renderSwatchRow();
    categoryAddForm.hidden = true;
    subcategoryFormFor = null;
    renderCategoryList();
    renderCategoryDropdown();
    renderSidebarGoals();
    renderDayPreview();
    renderAllGoalsModal();
    renderCalendar();
  });

  document.getElementById('categoryAddCancel').addEventListener('click', () => {
    categoryAddForm.hidden = true;
    categoryAddInput.value = '';
    subcategoryFormFor = null;
  });

  // ---------- custom category dropdown (add-goal form) ----------
  const cdTrigger = document.getElementById('cdTrigger');
  const cdMenu = document.getElementById('cdMenu');
  const cdDot = document.getElementById('cdDot');
  const cdLabel = document.getElementById('cdLabel');
  let expandedDropdownCategoryIds = new Set();

  function subcategoryName(cat, subId) {
    const sub = cat && cat.subcategories && cat.subcategories.find(s => s.id === subId);
    return sub ? sub.name : '';
  }

  function setSelectedCategory(id, subId) {
    const cat = findCategory(id) || allCategories()[0];
    selectedCategoryId = cat.id;
    selectedSubcategoryId = settings.subcategoriesEnabled ? (subId || null) : null;
    const sub = selectedSubcategoryId && cat.subcategories && cat.subcategories.find(s => s.id === selectedSubcategoryId);
    cdDot.style.background = (sub && sub.color) || cat.color;
    cdLabel.textContent = cat.name + (sub ? ' — ' + sub.name : '');
  }

  // Click-to-expand accordion, right inside the scrollable option list —
  // no hover timers, no separate floating panel to position, and it
  // works identically with a mouse or a finger.
  function renderCategoryDropdown() {
    cdMenu.innerHTML = '';
    allCategories().forEach(cat => {
      const hasSubs = settings.subcategoriesEnabled && !!(cat.subcategories && cat.subcategories.length);
      const isExpanded = hasSubs && expandedDropdownCategoryIds.has(cat.id);
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'cd-option';
      opt.setAttribute('role', 'option');

      const dot = document.createElement('span');
      dot.className = 'category-dot';
      dot.style.background = cat.color;
      opt.appendChild(dot);

      const label = document.createElement('span');
      label.className = 'cd-option-label';
      label.textContent = cat.name;
      opt.appendChild(label);

      // On the right, clearly visible (not a bare hover-only icon), so a
      // category's subcategories are an obvious, inviting thing to open
      // rather than a control the user has to go looking for.
      if (hasSubs) {
        const expandBtn = document.createElement('button');
        expandBtn.type = 'button';
        expandBtn.className = 'cd-expand-btn' + (isExpanded ? ' expanded' : '');
        expandBtn.setAttribute('aria-label', (isExpanded ? 'Hide' : 'Show') + ' ' + cat.name + ' subcategories');
        expandBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
        expandBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (expandedDropdownCategoryIds.has(cat.id)) expandedDropdownCategoryIds.delete(cat.id);
          else expandedDropdownCategoryIds.add(cat.id);
          renderCategoryDropdown();
        });
        opt.appendChild(expandBtn);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'cd-expand-spacer';
        opt.appendChild(spacer);
      }

      opt.addEventListener('click', () => {
        setSelectedCategory(cat.id, null);
        closeCategoryDropdown();
      });
      cdMenu.appendChild(opt);

      if (isExpanded) {
        cat.subcategories.forEach(sub => {
          const subOpt = document.createElement('button');
          subOpt.type = 'button';
          subOpt.className = 'cd-suboption';
          const subDot = document.createElement('span');
          subDot.className = 'category-dot';
          subDot.style.background = sub.color || cat.color;
          subOpt.appendChild(subDot);
          subOpt.appendChild(document.createTextNode(sub.name));
          subOpt.addEventListener('click', () => {
            setSelectedCategory(cat.id, sub.id);
            closeCategoryDropdown();
          });
          cdMenu.appendChild(subOpt);
        });
      }
    });
    if (!selectedCategoryId || !allCategories().some(c => c.id === selectedCategoryId)) {
      setSelectedCategory(allCategories()[0].id, null);
    }
  }

  function openCategoryDropdown() {
    cdMenu.hidden = false;
    cdTrigger.setAttribute('aria-expanded', 'true');
  }
  function closeCategoryDropdown() {
    cdMenu.hidden = true;
    cdTrigger.setAttribute('aria-expanded', 'false');
    if (expandedDropdownCategoryIds.size) {
      expandedDropdownCategoryIds = new Set();
      renderCategoryDropdown();
    }
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

  // ---------- goal times ----------
  function formatTime(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  // "9:45 – 10:45 AM" where the locale supports compact ranges.
  function formatTimeRange(start, end) {
    if (!end) return formatTime(start);
    const toDate = t => { const [h, m] = t.split(':').map(Number); return new Date(2000, 0, 1, h, m); };
    const fmt = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
    return fmt.formatRange ? fmt.formatRange(toDate(start), toDate(end)) : formatTime(start) + ' – ' + formatTime(end);
  }
  function timeToMinutes(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
  function minutesToTime(mins) { return pad2(Math.floor(mins / 60)) + ':' + pad2(mins % 60); }
  function formatDuration(mins) {
    const h = Math.floor(mins / 60), m = mins % 60;
    return h ? h + ' hr' + (m ? ' ' + m + ' min' : '') : m + ' min';
  }
  // " at 9:45 AM" / ", 9:45 – 10:45 AM" — appended to a date or repeat description.
  function timeSuffix(start, end) {
    if (!start) return '';
    return end ? ', ' + formatTimeRange(start, end) : ' at ' + formatTime(start);
  }
  // Earlier times first; goals without a time after every timed one.
  function compareTime(a, b) {
    if (a.time && b.time) return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
    return a.time ? -1 : b.time ? 1 : 0;
  }
  function compareInGroup(a, b) { return (b.stars || 0) - (a.stars || 0) || compareTime(a, b); }

  function sortGoals(list) {
    const withIndex = list.map((g, i) => ({ g, i }));
    if (settings.sortMode === 'significance') {
      withIndex.sort((a, b) => compareInGroup(a.g, b.g) || a.i - b.i);
    } else if (settings.sortMode === 'category') {
      withIndex.sort((a, b) => categoryRank(a.g.category) - categoryRank(b.g.category) || compareInGroup(a.g, b.g) || a.i - b.i);
    } else if (settings.sortMode === 'time') {
      withIndex.sort((a, b) => compareTime(a.g, b.g) || (b.g.stars || 0) - (a.g.stars || 0) || a.i - b.i);
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
      goals: byCategory.get(catId).slice().sort(compareInGroup)
    }));
  }

  // Splits one category's goals into its named subcategory groups (in the
  // category's own subcategory order) plus a "general" bucket for goals
  // with no subcategory (or one that no longer exists) — general goals
  // render last, same convention as "Any" sorting last at the top level.
  function groupGoalsBySubcategory(goalsInCategory, cat) {
    const subDefs = settings.subcategoriesEnabled ? ((cat && cat.subcategories) || []) : [];
    if (!subDefs.length) {
      return { general: goalsInCategory.slice().sort(compareInGroup), subGroups: [] };
    }
    const bySub = new Map();
    const general = [];
    goalsInCategory.forEach(g => {
      if (g.subcategory && subDefs.some(s => s.id === g.subcategory)) {
        if (!bySub.has(g.subcategory)) bySub.set(g.subcategory, []);
        bySub.get(g.subcategory).push(g);
      } else {
        general.push(g);
      }
    });
    const subGroups = subDefs
      .filter(s => bySub.has(s.id))
      .map(s => ({ subcategory: s, goals: bySub.get(s.id).slice().sort(compareInGroup) }));
    general.sort(compareInGroup);
    return { general, subGroups };
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
    renderAllGoalsModal();
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
    if (g.time) {
      const chip = document.createElement('span');
      chip.className = 'time-chip';
      chip.innerHTML = CLOCK_ICON_SVG;
      const chipText = document.createElement('span');
      chipText.textContent = formatTimeRange(g.time, g.endTime);
      chip.appendChild(chipText);
      meta.appendChild(chip);
    }
    const catInfo = settings.showCategories ? goalDisplayInfo(g) : null;
    if (catInfo && !opts.dotOnlyCategory) {
      const tag = document.createElement('span');
      tag.className = 'mini-category-tag';
      tag.style.background = catInfo.color;
      tag.textContent = catInfo.name;
      meta.appendChild(tag);
    }
    if (settings.showSignificance && g.stars) {
      const stars = document.createElement('span');
      stars.className = 'mini-stars';
      stars.innerHTML = starsHtml(g.stars);
      meta.appendChild(stars);
    }
    if (g.seriesId && settings.repeatingEnabled) {
      const s = series.find(x => x.id === g.seriesId);
      const badge = document.createElement('span');
      badge.className = 'repeat-badge';
      badge.title = s ? describeRule(s) + timeSuffix(s.time, s.endTime) + ' · ' + formatRange(dateFromKey(s.start), dateFromKey(s.end)) : 'Repeating goal';
      badge.innerHTML = REPEAT_ICON_SVG;
      const badgeText = document.createElement('span');
      badgeText.textContent = s ? shortRuleLabel(s) : 'Repeats';
      badge.appendChild(badgeText);
      meta.appendChild(badge);
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
      if (catInfo) {
        const dot = document.createElement('span');
        dot.className = 'category-dot goal-row-dot';
        dot.style.background = catInfo.color;
        dot.title = catInfo.name;
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
    // A repeat starts on the selected day, so its count follows the day.
    renderRepeatBtn();
  }

  // A small circular chevron for a goal-group/subgroup header, on its
  // right edge, that folds its goals away — collapsed state is shared
  // (via collapsedGroups) across every place that header can appear.
  function buildGroupCollapseBtn(key, collapsed, name, small) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'group-collapse-btn' + (small ? ' small' : '') + (collapsed ? ' collapsed' : '');
    btn.setAttribute('aria-label', (collapsed ? 'Expand' : 'Collapse') + ' ' + name);
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    return btn;
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

      // Collapsing only makes sense where a header is actually shown (the
      // day-preview hides headers for compactness) — otherwise a category
      // collapsed from the sidebar would make its goals silently vanish
      // from an unrelated, header-less view.
      const collapsible = !!opts.showCategoryHeaders;

      const appendGoalRow = (g, indent) => {
        const row = buildGoalRowEl(g, fullList, {
          dotOnlyCategory: true,
          canReorder: false,
          onRefresh: opts.onRefresh
        });
        // Pushed slightly right so a subcategory's goals read as visually
        // nested under it, distinct from the category's own general goals.
        if (indent) row.classList.add('goal-row-indented');
        container.appendChild(row);
      };

      groups.forEach(group => {
        const hasHeader = opts.showCategoryHeaders && group.category.id !== 'any';
        const groupKey = 'cat:' + group.category.id;
        const groupCollapsed = collapsible && collapsedGroups.has(groupKey);

        if (hasHeader) {
          const header = document.createElement('div');
          header.className = 'goal-group-header';
          const dot = document.createElement('span');
          dot.className = 'category-dot';
          dot.style.background = group.category.color;
          dot.title = group.category.name;
          header.appendChild(dot);
          header.appendChild(document.createTextNode(group.category.name));
          const collapseBtn = buildGroupCollapseBtn(groupKey, groupCollapsed, group.category.name, false);
          collapseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (collapsedGroups.has(groupKey)) collapsedGroups.delete(groupKey);
            else collapsedGroups.add(groupKey);
            opts.onRefresh();
          });
          header.appendChild(collapseBtn);
          container.appendChild(header);
        }

        if (groupCollapsed) return;

        const { general, subGroups } = groupGoalsBySubcategory(group.goals, group.category);
        subGroups.forEach(sg => {
          const subKey = 'sub:' + group.category.id + ':' + sg.subcategory.id;
          const subCollapsed = collapsible && collapsedGroups.has(subKey);
          if (opts.showCategoryHeaders) {
            const subHeader = document.createElement('div');
            subHeader.className = 'goal-subgroup-header';
            const subDot = document.createElement('span');
            subDot.className = 'category-dot';
            subDot.style.background = sg.subcategory.color || group.category.color;
            subHeader.appendChild(subDot);
            subHeader.appendChild(document.createTextNode(sg.subcategory.name));
            const subCollapseBtn = buildGroupCollapseBtn(subKey, subCollapsed, sg.subcategory.name, true);
            subCollapseBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              if (collapsedGroups.has(subKey)) collapsedGroups.delete(subKey);
              else collapsedGroups.add(subKey);
              opts.onRefresh();
            });
            subHeader.appendChild(subCollapseBtn);
            container.appendChild(subHeader);
          }
          if (subCollapsed) return;
          sg.goals.forEach(g => appendGoalRow(g, true));
        });
        general.forEach(g => appendGoalRow(g, false));
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

  // ---------- "All goals" modal (every day, at once) ----------
  let allGoalsModalOpen = false;

  function dateFromKey(k) {
    const parts = k.split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function renderAllGoalsModal() {
    if (!allGoalsModalOpen) return;
    allGoalsBody.innerHTML = '';

    const dateKeys = Object.keys(data)
      .filter(k => isDateKey(k) && Array.isArray(data[k]) && data[k].length)
      .sort();

    let total = 0;
    dateKeys.forEach(k => {
      const fullList = data[k];
      const filteredList = categoryFilter ? fullList.filter(g => g.category === categoryFilter) : fullList;
      if (!filteredList.length) return;
      total += filteredList.length;

      const dateObj = dateFromKey(k);
      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'all-goals-date-header';
      header.textContent = (sameDay(dateObj, today) ? 'Today · ' : '') +
        WEEKDAY_FULL[dateObj.getDay()] + ', ' + MONTH_NAMES[dateObj.getMonth()] + ' ' + dateObj.getDate() + ', ' + dateObj.getFullYear();
      header.addEventListener('click', () => {
        selectedDay = dateObj;
        viewYear = dateObj.getFullYear();
        viewMonth = dateObj.getMonth();
        closeAllGoalsModal();
        renderCalendar();
        renderSidebarGoals();
      });
      allGoalsBody.appendChild(header);

      const dateGroup = document.createElement('div');
      dateGroup.className = 'all-goals-date-group';
      renderGoalListInto(dateGroup, fullList, filteredList, {
        dotOnlyCategory: true,
        canReorder: false,
        showCategoryHeaders: true,
        onRefresh: refreshAfterGoalChange
      });
      allGoalsBody.appendChild(dateGroup);
    });

    allGoalsCount.textContent = total + (total === 1 ? ' goal total' : ' goals total');

    if (!total) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No goals yet.';
      allGoalsBody.appendChild(empty);
    }
  }

  function openAllGoalsModal() {
    allGoalsModalOpen = true;
    renderAllGoalsModal();
    allGoalsModal.classList.add('open');
    allGoalsOverlay.classList.add('open');
  }

  function closeAllGoalsModal() {
    allGoalsModalOpen = false;
    allGoalsModal.classList.remove('open');
    allGoalsOverlay.classList.remove('open');
  }

  allGoalsBtn.addEventListener('click', openAllGoalsModal);
  allGoalsCloseBtn.addEventListener('click', closeAllGoalsModal);
  allGoalsOverlay.addEventListener('click', closeAllGoalsModal);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllGoalsModal(); });

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

  // A goal that was just added must be visible — a category filter or a
  // collapsed group would otherwise hide it, which looks exactly like the
  // add silently failing.
  function revealNewGoal(g) {
    if (categoryFilter && categoryFilter !== g.category) {
      categoryFilter = null;
      renderCategoryList();
    }
    collapsedGroups.delete('cat:' + g.category);
    if (g.subcategory) collapsedGroups.delete('sub:' + g.category + ':' + g.subcategory);
  }

  dpAddForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = dpAddInput.value.trim();
    if (!text || !previewDay) return;
    const k = keyForDate(previewDay);
    if (!data[k]) data[k] = [];
    const goal = {
      id: 'g_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      text: text,
      done: false,
      category: dpCategoryId || allCategories()[0].id,
      stars: dpStarValue
    };
    data[k].push(goal);
    scheduleSave();
    dpAddInput.value = '';
    dpStarValue = 0;
    renderDpStarPicker();
    revealNewGoal(goal);
    refreshAfterGoalChange();
  });

  // Closes an open inline "add subgoal" form when clicking anywhere else.
  document.addEventListener('click', (e) => {
    if (!openSubgoalFormFor) return;
    if (e.target.closest('.subgoal-add-form') || e.target.closest('.subgoal-add-btn')) return;
    openSubgoalFormFor = null;
    renderSidebarGoals();
    renderDayPreview();
    renderAllGoalsModal();
  });

  function addGoalToSelectedDay() {
    const text = sidebarAddInput.value.trim();
    if (!text) return;
    // Pressing Enter with a popover still open counts as keeping its choices.
    closeRepeatPop(true);
    closeTimePop(true);
    if (repeatDraft && settings.repeatingEnabled) {
      addRepeatingGoal(text);
      return;
    }
    const k = keyForDate(selectedDay);
    if (!data[k]) data[k] = [];
    const goal = {
      id: 'g_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      text: text,
      done: false,
      category: selectedCategoryId || allCategories()[0].id,
      subcategory: selectedSubcategoryId || null,
      stars: starPickerValue
    };
    applyTimeDraft(goal);
    data[k].push(goal);
    scheduleSave();
    resetAddForm();
    revealNewGoal(goal);
    refreshAfterGoalChange();
  }

  function applyTimeDraft(target) {
    if (!timeDraft) return;
    target.time = timeDraft.start;
    if (timeDraft.end) target.endTime = timeDraft.end;
  }

  // Per-goal choices reset after each add; the category stays, since several
  // goals in a row often share one.
  function resetAddForm() {
    sidebarAddInput.value = '';
    starPickerValue = 0;
    renderStarPicker();
    repeatDraft = null;
    renderRepeatBtn();
    timeDraft = null;
    renderTimeBtn();
  }

  document.getElementById('sidebarAddForm').addEventListener('submit', (e) => {
    e.preventDefault();
    addGoalToSelectedDay();
  });

  const addStatus = document.getElementById('addStatus');
  let addStatusTimer = null;
  function showAddStatus(msg, isError) {
    addStatus.textContent = msg;
    addStatus.classList.toggle('error', !!isError);
    addStatus.classList.add('show');
    clearTimeout(addStatusTimer);
    addStatusTimer = setTimeout(() => addStatus.classList.remove('show'), 6000);
  }

  // ---------- repeating goals: dates & wording ----------
  function addDays(d, n) {
    const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    r.setDate(r.getDate() + n);
    return r;
  }
  // Same day-of-month n months later, clamped to that month's last day
  // (Jan 31 + 1 month is Feb 28/29, not Mar 3).
  function addMonths(d, n) {
    const y = d.getFullYear(), m = d.getMonth() + n;
    const last = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(d.getDate(), last));
  }
  function shortDate(d) { return MONTH_NAMES[d.getMonth()].slice(0, 3) + ' ' + d.getDate(); }
  function shortDateWithDay(d) { return WEEKDAY_SHORT[d.getDay()] + ', ' + shortDate(d); }
  function formatRange(a, b) {
    const thisYear = new Date().getFullYear();
    const plain = a.getFullYear() === thisYear && b.getFullYear() === thisYear;
    const fmt = d => shortDate(d) + (plain ? '' : ', ' + d.getFullYear());
    return sameDay(a, b) ? fmt(a) : fmt(a) + ' – ' + fmt(b);
  }
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function orderedWeekdays(days) {
    return days.slice().sort((a, b) => ((a - settings.weekStart + 7) % 7) - ((b - settings.weekStart + 7) % 7));
  }
  function joinWords(words) {
    return words.length <= 1 ? words.join('') : words.slice(0, -1).join(', ') + ' & ' + words[words.length - 1];
  }
  function describeRule(rule) {
    if (rule.freq === 'daily') return 'Every day';
    if (rule.freq === 'alternate') return 'Every other day';
    if (rule.freq === 'weekly') {
      if (rule.weekdays.length === 7) return 'Every day';
      return 'Every ' + joinWords(orderedWeekdays(rule.weekdays).map(d => WEEKDAY_SHORT[d]));
    }
    return 'Monthly on the ' + ordinal(rule.monthDay);
  }
  function shortRuleLabel(rule) {
    if (rule.freq === 'daily') return 'Daily';
    if (rule.freq === 'alternate') return 'Every 2 days';
    if (rule.freq === 'weekly') {
      if (rule.weekdays.length === 7) return 'Daily';
      if (rule.weekdays.length <= 2) return orderedWeekdays(rule.weekdays).map(d => WEEKDAY_SHORT[d]).join(', ');
      return rule.weekdays.length + '× a week';
    }
    return 'Monthly';
  }

  // Every date key from start to end (inclusive) that the rule lands on.
  function occurrenceKeys(rule, start, end) {
    const keys = [];
    if (rule.freq === 'monthly') {
      for (let i = 0; ; i++) {
        const y = start.getFullYear(), m = start.getMonth() + i;
        const last = new Date(y, m + 1, 0).getDate();
        const d = new Date(y, m, Math.min(rule.monthDay, last));
        if (d > end) break;
        if (d >= start) keys.push(keyForDate(d));
      }
      return keys;
    }
    const step = rule.freq === 'alternate' ? 2 : 1;
    for (let d = addDays(start, 0); d <= end; d = addDays(d, step)) {
      if (rule.freq === 'weekly' && !rule.weekdays.includes(d.getDay())) continue;
      keys.push(keyForDate(d));
    }
    return keys;
  }

  // ---------- repeating goals: the pending repeat for the add form ----------
  function repeatStartDay() { return new Date(selectedDay.getFullYear(), selectedDay.getMonth(), selectedDay.getDate()); }

  function defaultRepeatDraft() {
    const start = repeatStartDay();
    return {
      freq: 'daily',
      weekdays: [start.getDay()],
      monthDay: start.getDate(),
      duration: '1m',
      until: keyForDate(addDays(addMonths(start, 1), -1)),
      durationTouched: false
    };
  }

  function draftEnd(draft, start) {
    let end;
    if (draft.duration === 'custom') end = draft.until ? dateFromKey(draft.until) : start;
    else if (draft.duration === '1w') end = addDays(start, 6);
    else end = addDays(addMonths(start, { '1m': 1, '3m': 3, '6m': 6 }[draft.duration]), -1);
    const max = addDays(start, REPEAT_MAX_DAYS - 1);
    return end > max ? max : end;
  }

  // Starts on the sidebar's selected day — the day the goal is being added to.
  function draftPlan(draft) {
    const start = repeatStartDay();
    const end = draftEnd(draft, start);
    return { start, end, keys: end < start ? [] : occurrenceKeys(draft, start, end) };
  }

  const repeatBtn = document.getElementById('repeatBtn');
  const repeatBtnLabel = document.getElementById('repeatBtnLabel');

  function renderRepeatBtn() {
    repeatBtn.classList.toggle('active', !!repeatDraft);
    if (!repeatDraft) {
      repeatBtnLabel.textContent = 'Off';
      repeatBtn.title = 'Repeat this goal on other days';
      return;
    }
    const plan = draftPlan(repeatDraft);
    repeatBtnLabel.textContent = shortRuleLabel(repeatDraft) + ' · ' + plan.keys.length + '×';
    repeatBtn.title = describeRule(repeatDraft) + (timeDraft ? timeSuffix(timeDraft.start, timeDraft.end) : '') + ', ' + plan.keys.length + ' times';
  }

  function addRepeatingGoal(text) {
    const plan = draftPlan(repeatDraft);
    if (!plan.keys.length) {
      showAddStatus('No days in that range match the repeat. Pick more days or a longer time.', true);
      return;
    }
    const s = {
      id: 'rs_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      text: text,
      category: selectedCategoryId || allCategories()[0].id,
      subcategory: selectedSubcategoryId || null,
      stars: starPickerValue,
      freq: repeatDraft.freq,
      weekdays: repeatDraft.freq === 'weekly' ? repeatDraft.weekdays.slice() : [],
      monthDay: repeatDraft.monthDay,
      start: plan.keys[0],
      end: plan.keys[plan.keys.length - 1]
    };
    applyTimeDraft(s);
    series.push(s);
    let first = null;
    plan.keys.forEach((k, i) => {
      const g = {
        id: 'g_' + Date.now() + '_' + i + '_' + Math.random().toString(36).slice(2, 7),
        text: text,
        done: false,
        category: s.category,
        subcategory: s.subcategory,
        stars: s.stars,
        seriesId: s.id
      };
      applyTimeDraft(g);
      if (!data[k]) data[k] = [];
      data[k].push(g);
      if (!first) first = g;
    });
    scheduleSave();
    resetAddForm();
    revealNewGoal(first);
    refreshAfterGoalChange();
    renderRepeatingModal();
    showAddStatus('Added ' + plan.keys.length + (plan.keys.length === 1 ? ' time' : ' times') +
      ' (' + describeRule(s) + timeSuffix(s.time, s.endTime) + '), starting ' + shortDateWithDay(dateFromKey(plan.keys[0])) + '.');
  }

  // ---------- repeating goals: the "Repeat" popover ----------
  const repeatPop = document.getElementById('repeatPop');
  const repeatFreqGrid = document.getElementById('repeatFreqGrid');
  const repeatWeekdaysSection = document.getElementById('repeatWeekdaysSection');
  const repeatWeekdays = document.getElementById('repeatWeekdays');
  const repeatMonthDaySection = document.getElementById('repeatMonthDaySection');
  const repeatMonthDay = document.getElementById('repeatMonthDay');
  const repeatMonthDayHint = document.getElementById('repeatMonthDayHint');
  const repeatDurations = document.getElementById('repeatDurations');
  const repeatUntil = document.getElementById('repeatUntil');
  const repeatSummary = document.getElementById('repeatSummary');
  const repeatDoneBtn = document.getElementById('repeatDoneBtn');
  let repeatEdit = null; // working copy while the popover is open
  // Whether the working copy is worth keeping on an outside click. Clicking
  // "Add goal" straight after picking options must not throw them away, but
  // opening the popover by accident and clicking off shouldn't set a repeat.
  let repeatEditDirty = false;

  // The choice buttons are built once and only restyled afterwards —
  // rebuilding them mid-click would detach the click's own target.
  REPEAT_FREQS.forEach(f => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'repeat-choice';
    b.dataset.freq = f.id;
    b.textContent = f.label;
    b.addEventListener('click', () => {
      repeatEdit.freq = f.id;
      // Monthly over a single month is just one day — default it longer.
      if (!repeatEdit.durationTouched) repeatEdit.duration = f.id === 'monthly' ? '6m' : '1m';
      repeatEditDirty = true;
      syncRepeatPop();
    });
    repeatFreqGrid.appendChild(b);
  });

  REPEAT_DURATIONS.forEach(dur => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'repeat-chip';
    b.dataset.duration = dur.id;
    b.textContent = dur.label;
    b.addEventListener('click', () => {
      if (dur.id === 'custom' && repeatEdit.duration !== 'custom') {
        repeatEdit.until = keyForDate(draftEnd(repeatEdit, repeatStartDay()));
      }
      repeatEdit.duration = dur.id;
      repeatEdit.durationTouched = true;
      repeatEditDirty = true;
      syncRepeatPop();
    });
    repeatDurations.appendChild(b);
  });

  // Rebuilt on open (never mid-click) so it follows the week-start setting.
  function buildWeekdayButtons() {
    repeatWeekdays.innerHTML = '';
    for (let i = 0; i < 7; i++) {
      const day = (settings.weekStart + i) % 7;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'repeat-weekday';
      b.dataset.day = day;
      b.textContent = WEEKDAY_TWO[day];
      b.setAttribute('aria-label', WEEKDAY_FULL[day]);
      b.addEventListener('click', () => {
        const has = repeatEdit.weekdays.includes(day);
        if (has && repeatEdit.weekdays.length === 1) return;
        repeatEdit.weekdays = has ? repeatEdit.weekdays.filter(d => d !== day) : repeatEdit.weekdays.concat(day);
        repeatEditDirty = true;
        syncRepeatPop();
      });
      repeatWeekdays.appendChild(b);
    }
  }

  repeatMonthDay.addEventListener('input', () => {
    const n = parseInt(repeatMonthDay.value, 10);
    if (n >= 1 && n <= 31) {
      repeatEdit.monthDay = n;
      repeatEditDirty = true;
      syncRepeatPop(true);
    }
  });
  repeatMonthDay.addEventListener('blur', () => { if (repeatEdit) repeatMonthDay.value = repeatEdit.monthDay; });
  repeatUntil.addEventListener('change', () => {
    if (!repeatUntil.value) return;
    repeatEdit.until = repeatUntil.value;
    repeatEditDirty = true;
    syncRepeatPop(true);
  });

  // fromInput: the change came from a text/date field, so don't overwrite it mid-typing.
  function syncRepeatPop(fromInput) {
    const e = repeatEdit;
    repeatFreqGrid.querySelectorAll('.repeat-choice').forEach(b => b.classList.toggle('selected', b.dataset.freq === e.freq));
    repeatWeekdaysSection.hidden = e.freq !== 'weekly';
    repeatWeekdays.querySelectorAll('.repeat-weekday').forEach(b => b.classList.toggle('selected', e.weekdays.includes(Number(b.dataset.day))));
    repeatMonthDaySection.hidden = e.freq !== 'monthly';
    if (!fromInput) repeatMonthDay.value = e.monthDay;
    repeatMonthDayHint.hidden = e.monthDay <= 28;
    repeatDurations.querySelectorAll('.repeat-chip').forEach(b => b.classList.toggle('selected', b.dataset.duration === e.duration));

    const start = repeatStartDay();
    repeatUntil.hidden = e.duration !== 'custom';
    repeatUntil.min = keyForDate(start);
    repeatUntil.max = keyForDate(addDays(start, REPEAT_MAX_DAYS - 1));
    if (!fromInput) repeatUntil.value = e.until;

    const plan = draftPlan(e);
    repeatSummary.innerHTML = '';
    repeatSummary.classList.toggle('warn', !plan.keys.length);
    if (!plan.keys.length) {
      repeatSummary.textContent = 'No days in this range match. Pick more days or a longer time.';
    } else {
      const count = document.createElement('strong');
      count.textContent = plan.keys.length + (plan.keys.length === 1 ? ' time' : ' times');
      repeatSummary.appendChild(count);
      repeatSummary.appendChild(document.createTextNode(' · ' + formatRange(dateFromKey(plan.keys[0]), dateFromKey(plan.keys[plan.keys.length - 1]))));
      const rule = document.createElement('div');
      rule.className = 'pop-summary-sub';
      rule.textContent = describeRule(e) + (timeDraft ? timeSuffix(timeDraft.start, timeDraft.end) : '') +
        ', starting ' + shortDateWithDay(dateFromKey(plan.keys[0]));
      repeatSummary.appendChild(rule);
    }
    repeatDoneBtn.disabled = !plan.keys.length;
    positionRepeatPop();
  }

  // To the right of the Repeat button when there's room (desktop), else
  // below or above it (mobile, where the sidebar spans the full width).
  function positionRepeatPop() { positionPopover(repeatPop, repeatBtn); }

  // Places a small popover window beside the button that opened it.
  function positionPopover(pop, btn) {
    if (pop.hidden) return;
    const r = btn.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const gap = 12, edge = 8;
    let left, top, side;
    if (r.right + gap + pw <= window.innerWidth - edge) {
      side = 'right';
      left = r.right + gap;
      top = r.top + r.height / 2 - ph / 2;
    } else {
      side = 'below';
      left = r.right - pw;
      top = r.bottom + gap;
      // Above clears the button's whole row (its label too), not just the button.
      const rowTop = btn.parentElement.getBoundingClientRect().top;
      if (top + ph > window.innerHeight - edge && rowTop - gap - ph >= edge) {
        side = 'above';
        top = rowTop - gap - ph;
      }
    }
    left = Math.max(edge, Math.min(left, window.innerWidth - pw - edge));
    top = Math.max(edge, Math.min(top, window.innerHeight - ph - edge));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    pop.dataset.side = side;
    // Keep the little pointer aimed at the button even after clamping.
    pop.style.setProperty('--arrow-y', Math.max(16, Math.min(ph - 16, r.top + r.height / 2 - top)) + 'px');
    pop.style.setProperty('--arrow-x', Math.max(16, Math.min(pw - 16, r.left + r.width / 2 - left)) + 'px');
  }

  // intent: opened deliberately to set up a repeat (from the Repeating
  // section), so even untouched defaults should stick.
  function openRepeatPop(intent) {
    repeatEdit = repeatDraft ? JSON.parse(JSON.stringify(repeatDraft)) : defaultRepeatDraft();
    repeatEditDirty = !!repeatDraft || !!intent;
    buildWeekdayButtons();
    repeatPop.hidden = false;
    repeatBtn.classList.add('open');
    repeatBtn.setAttribute('aria-expanded', 'true');
    syncRepeatPop();
  }

  // commit: keep the working copy (if it was touched and lands on any day);
  // otherwise discard it and leave the previous setting as it was.
  function closeRepeatPop(commit) {
    if (repeatPop.hidden) return;
    if (commit && repeatEditDirty && draftPlan(repeatEdit).keys.length) repeatDraft = repeatEdit;
    repeatPop.hidden = true;
    repeatEdit = null;
    repeatBtn.classList.remove('open');
    repeatBtn.setAttribute('aria-expanded', 'false');
    renderRepeatBtn();
  }

  repeatBtn.addEventListener('click', () => {
    if (repeatPop.hidden) openRepeatPop(false); else closeRepeatPop(true);
  });
  document.getElementById('repeatPopClose').addEventListener('click', () => closeRepeatPop(false));
  repeatDoneBtn.addEventListener('click', () => {
    repeatEditDirty = true;
    closeRepeatPop(true);
    if (!sidebarAddInput.value.trim()) sidebarAddInput.focus();
  });
  document.getElementById('repeatClearBtn').addEventListener('click', () => {
    repeatDraft = null;
    closeRepeatPop(false);
  });
  repeatPop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !repeatDoneBtn.disabled) {
      e.preventDefault();
      repeatDoneBtn.click();
    }
  });
  document.addEventListener('click', (e) => {
    if (repeatPop.hidden) return;
    const path = e.composedPath();
    if (path.includes(repeatPop) || path.includes(repeatBtn)) return;
    closeRepeatPop(true);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRepeatPop(false); });
  window.addEventListener('resize', positionRepeatPop);
  document.addEventListener('scroll', positionRepeatPop, true);

  // ---------- goal times: the "Time" popover ----------
  const timeBtn = document.getElementById('timeBtn');
  const timeBtnLabel = document.getElementById('timeBtnLabel');
  const timePop = document.getElementById('timePop');
  const timeStartInput = document.getElementById('timeStartInput');
  const timeEndInput = document.getElementById('timeEndInput');
  const timeAddEndBtn = document.getElementById('timeAddEndBtn');
  const timeEndRow = document.getElementById('timeEndRow');
  const timeSummary = document.getElementById('timeSummary');
  const timeDoneBtn = document.getElementById('timeDoneBtn');
  const LAST_MINUTE = 23 * 60 + 59;
  let timeEdit = null; // { start, end } working copy while the popover is open
  let timeEditDirty = false; // same keep-on-click-away rule as the Repeat popover

  function renderTimeBtn() {
    timeBtn.classList.toggle('active', !!timeDraft);
    timeBtnLabel.textContent = timeDraft ? formatTimeRange(timeDraft.start, timeDraft.end) : 'Off';
    timeBtn.title = timeDraft ? 'Change the time' : 'Give this goal a time of day';
    renderRepeatBtn(); // its tooltip mentions the time
  }

  function timeEditValid(e) { return !!e.start && (!e.end || e.end > e.start); }

  // The next half hour when timing something for today, else 9:00 AM.
  function defaultStartTime() {
    const now = new Date();
    if (sameDay(selectedDay, now)) {
      const next = Math.ceil((now.getHours() * 60 + now.getMinutes() + 1) / 30) * 30;
      if (next <= 23 * 60 + 30) return minutesToTime(next);
    }
    return '09:00';
  }

  // fromInput: the change came from one of the time fields, so leave them be.
  function syncTimePop(fromInput) {
    const e = timeEdit;
    if (!fromInput) {
      timeStartInput.value = e.start || '';
      timeEndInput.value = e.end || '';
    }
    timeAddEndBtn.hidden = !!e.end;
    timeEndRow.hidden = !e.end;

    const valid = timeEditValid(e);
    timeSummary.innerHTML = '';
    timeSummary.classList.toggle('warn', !valid);
    if (!e.start) {
      timeSummary.textContent = 'Pick a start time.';
    } else if (!valid) {
      timeSummary.textContent = 'The end time is before the start time.';
    } else {
      const strong = document.createElement('strong');
      strong.textContent = formatTimeRange(e.start, e.end);
      timeSummary.appendChild(strong);
      if (e.end) timeSummary.appendChild(document.createTextNode(' · ' + formatDuration(timeToMinutes(e.end) - timeToMinutes(e.start))));
      const sub = document.createElement('div');
      sub.className = 'pop-summary-sub';
      const when = repeatDraft ? describeRule(repeatDraft)
        : sameDay(selectedDay, new Date()) ? 'Today' : shortDateWithDay(selectedDay);
      sub.textContent = when + timeSuffix(e.start, e.end);
      timeSummary.appendChild(sub);
    }
    timeDoneBtn.disabled = !valid;
    positionPopover(timePop, timeBtn);
  }

  function openTimePop() {
    timeEdit = timeDraft ? { start: timeDraft.start, end: timeDraft.end } : { start: defaultStartTime(), end: null };
    timeEditDirty = !!timeDraft;
    timePop.hidden = false;
    timeBtn.classList.add('open');
    timeBtn.setAttribute('aria-expanded', 'true');
    syncTimePop();
    timeStartInput.focus(); // ready to type, e.g. "945a"
  }

  function closeTimePop(commit) {
    if (timePop.hidden) return;
    if (commit && timeEditDirty && timeEditValid(timeEdit)) timeDraft = { start: timeEdit.start, end: timeEdit.end };
    timePop.hidden = true;
    timeEdit = null;
    timeBtn.classList.remove('open');
    timeBtn.setAttribute('aria-expanded', 'false');
    renderTimeBtn();
  }

  timeStartInput.addEventListener('input', () => {
    if (!timeStartInput.value) return;
    // Moving the start carries the end along, keeping the same length.
    if (timeEdit.end && timeEdit.start && timeEdit.end > timeEdit.start) {
      const length = timeToMinutes(timeEdit.end) - timeToMinutes(timeEdit.start);
      timeEdit.end = minutesToTime(Math.min(timeToMinutes(timeStartInput.value) + length, LAST_MINUTE));
      timeEndInput.value = timeEdit.end;
    }
    timeEdit.start = timeStartInput.value;
    timeEditDirty = true;
    syncTimePop(true);
  });
  timeEndInput.addEventListener('input', () => {
    if (!timeEndInput.value) return;
    timeEdit.end = timeEndInput.value;
    timeEditDirty = true;
    syncTimePop(true);
  });
  timeAddEndBtn.addEventListener('click', () => {
    const start = timeEdit.start || defaultStartTime();
    timeEdit.end = minutesToTime(Math.min(timeToMinutes(start) + 60, LAST_MINUTE));
    timeEditDirty = true;
    syncTimePop();
    timeEndInput.focus();
  });
  document.getElementById('timeRemoveEndBtn').addEventListener('click', () => {
    timeEdit.end = null;
    timeEditDirty = true;
    syncTimePop();
  });

  timeBtn.addEventListener('click', () => {
    if (timePop.hidden) openTimePop(); else closeTimePop(true);
  });
  document.getElementById('timePopClose').addEventListener('click', () => closeTimePop(false));
  timeDoneBtn.addEventListener('click', () => {
    timeEditDirty = true;
    closeTimePop(true);
    if (!sidebarAddInput.value.trim()) sidebarAddInput.focus();
  });
  document.getElementById('timeClearBtn').addEventListener('click', () => {
    timeDraft = null;
    closeTimePop(false);
  });
  timePop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !timeDoneBtn.disabled) {
      e.preventDefault();
      timeDoneBtn.click();
    }
  });
  document.addEventListener('click', (e) => {
    if (timePop.hidden) return;
    const path = e.composedPath();
    if (path.includes(timePop) || path.includes(timeBtn)) return;
    closeTimePop(true);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTimePop(false); });
  window.addEventListener('resize', () => positionPopover(timePop, timeBtn));
  document.addEventListener('scroll', () => positionPopover(timePop, timeBtn), true);

  // ---------- repeating goals: the "Repeating" section ----------
  const repeatingBtn = document.getElementById('repeatingBtn');
  const repeatingModal = document.getElementById('repeatingModal');
  const repeatingOverlay = document.getElementById('repeatingOverlay');
  const repeatingBody = document.getElementById('repeatingBody');
  const repeatingCount = document.getElementById('repeatingCount');
  let repeatingModalOpen = false;

  function seriesStats() {
    const todayKey = keyForDate(new Date());
    const stats = new Map();
    Object.keys(data).forEach(k => {
      if (!isDateKey(k) || !Array.isArray(data[k])) return;
      data[k].forEach(g => {
        if (!g.seriesId) return;
        let st = stats.get(g.seriesId);
        if (!st) { st = { total: 0, done: 0, next: null }; stats.set(g.seriesId, st); }
        st.total++;
        if (g.done) st.done++;
        if (!g.done && k >= todayKey && (!st.next || k < st.next)) st.next = k;
      });
    });
    return stats;
  }

  // Drops a series' occurrences (all of them, or those keep() rejects),
  // then trims its date range to what's left — or drops it entirely.
  function pruneSeries(s, keep) {
    const left = [];
    Object.keys(data).forEach(k => {
      if (!isDateKey(k) || !Array.isArray(data[k])) return;
      data[k] = data[k].filter(g => g.seriesId !== s.id || (keep && keep(k, g)));
      if (data[k].some(g => g.seriesId === s.id)) left.push(k);
    });
    if (!left.length) series = series.filter(x => x !== s);
    else { left.sort(); s.start = left[0]; s.end = left[left.length - 1]; }
    scheduleSave();
    refreshAfterGoalChange();
    renderRepeatingModal();
  }

  // Two taps for anything destructive — the first only arms the button.
  function armConfirm(btn, confirmLabel, action) {
    const label = btn.textContent;
    let timer = null;
    btn.addEventListener('click', () => {
      if (!btn.classList.contains('armed')) {
        btn.classList.add('armed');
        btn.textContent = confirmLabel;
        timer = setTimeout(() => { btn.classList.remove('armed'); btn.textContent = label; }, 4000);
        return;
      }
      clearTimeout(timer);
      action();
    });
  }

  function jumpToDay(k) {
    const d = dateFromKey(k);
    selectedDay = d;
    viewYear = d.getFullYear();
    viewMonth = d.getMonth();
    renderCalendar();
    renderSidebarGoals();
  }

  function buildSeriesCard(s, st) {
    const card = document.createElement('div');
    card.className = 'repeat-card' + (st.next ? '' : ' finished');
    const info = goalDotInfo(s);

    const top = document.createElement('div');
    top.className = 'repeat-card-top';
    const dot = document.createElement('span');
    dot.className = 'category-dot';
    dot.style.background = info.color;
    top.appendChild(dot);
    const title = document.createElement('span');
    title.className = 'repeat-card-title';
    title.textContent = s.text;
    top.appendChild(title);
    if (displayCategory(s.category)) {
      const tag = document.createElement('span');
      tag.className = 'repeat-card-tag';
      tag.textContent = info.name;
      top.appendChild(tag);
    }
    card.appendChild(top);

    const rule = document.createElement('div');
    rule.className = 'repeat-card-rule';
    rule.innerHTML = REPEAT_ICON_SVG;
    rule.appendChild(document.createTextNode(describeRule(s) + timeSuffix(s.time, s.endTime) + ' · ' + formatRange(dateFromKey(s.start), dateFromKey(s.end))));
    card.appendChild(rule);

    const bar = document.createElement('div');
    bar.className = 'repeat-progress';
    const fill = document.createElement('div');
    fill.className = 'repeat-progress-fill';
    fill.style.width = (st.total ? Math.round(st.done / st.total * 100) : 0) + '%';
    fill.style.background = info.color;
    bar.appendChild(fill);
    card.appendChild(bar);

    const meta = document.createElement('div');
    meta.className = 'repeat-card-meta';
    meta.appendChild(document.createTextNode(st.done + ' of ' + st.total + ' done'));
    if (st.next) {
      meta.appendChild(document.createTextNode(' · Next: '));
      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'repeat-next-link';
      next.textContent = st.next === keyForDate(new Date()) ? 'Today' : shortDateWithDay(dateFromKey(st.next));
      next.title = 'Go to that day';
      next.addEventListener('click', () => { closeRepeatingModal(); jumpToDay(st.next); });
      meta.appendChild(next);
    } else {
      meta.appendChild(document.createTextNode(' · Finished'));
    }
    card.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'repeat-card-actions';
    if (st.next) {
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'mini-btn-ghost';
      stop.textContent = 'Stop repeating';
      stop.title = 'Removes the days after today that aren\'t done yet. Past days stay.';
      const todayKey = keyForDate(new Date());
      armConfirm(stop, 'Remove upcoming days?', () => pruneSeries(s, (k, g) => k <= todayKey || g.done));
      actions.appendChild(stop);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'mini-btn-ghost repeat-delete-btn';
    del.textContent = 'Delete all';
    armConfirm(del, 'Delete all ' + st.total + '?', () => pruneSeries(s, null));
    actions.appendChild(del);
    card.appendChild(actions);
    return card;
  }

  function renderRepeatingModal() {
    if (!repeatingModalOpen) return;
    const stats = seriesStats();
    // Occurrences can also be deleted one at a time from their days — once
    // none are left, the series itself is gone too.
    const kept = series.filter(s => stats.has(s.id));
    if (kept.length !== series.length) { series = kept; scheduleSave(); }

    const active = [], finished = [];
    series.forEach(s => {
      const st = stats.get(s.id);
      (st.next ? active : finished).push({ s, st });
    });
    active.sort((a, b) => (a.st.next < b.st.next ? -1 : a.st.next > b.st.next ? 1 : 0));
    finished.sort((a, b) => (a.s.end < b.s.end ? 1 : -1));

    repeatingCount.textContent = active.length + ' active' + (finished.length ? ' · ' + finished.length + ' finished' : '');
    repeatingBody.innerHTML = '';

    if (!series.length) {
      const empty = document.createElement('div');
      empty.className = 'repeat-empty';
      empty.innerHTML = REPEAT_ICON_SVG +
        '<p class="repeat-empty-title">No repeating goals yet</p>' +
        '<p>Add a goal in the sidebar and tap <strong>Repeat</strong> to have it show up every day, every other day, every week, or every month.</p>';
      repeatingBody.appendChild(empty);
      return;
    }

    [['Active', active], ['Finished', finished]].forEach(([title, items]) => {
      if (!items.length) return;
      const h = document.createElement('div');
      h.className = 'repeat-list-title';
      h.textContent = title;
      repeatingBody.appendChild(h);
      items.forEach(({ s, st }) => repeatingBody.appendChild(buildSeriesCard(s, st)));
    });
  }

  function openRepeatingModal() {
    repeatingModalOpen = true;
    renderRepeatingModal();
    repeatingModal.classList.add('open');
    repeatingOverlay.classList.add('open');
  }
  function closeRepeatingModal() {
    repeatingModalOpen = false;
    repeatingModal.classList.remove('open');
    repeatingOverlay.classList.remove('open');
  }

  // Straight from the Repeating section into setting one up: open the
  // sidebar if it's collapsed, then the Repeat popover. Deferred so the
  // click that got us here doesn't count as an outside click and close it.
  function startNewRepeatingGoal() {
    const wasCollapsed = settings.sidebarCollapsed;
    if (wasCollapsed) {
      settings.sidebarCollapsed = false;
      saveSettings();
      applySidebarCollapsed();
    }
    setTimeout(() => {
      repeatBtn.scrollIntoView({ block: 'nearest' });
      sidebarAddInput.focus({ preventScroll: true });
      openRepeatPop(true);
    }, wasCollapsed ? 340 : 0);
  }

  repeatingBtn.addEventListener('click', openRepeatingModal);
  document.getElementById('repeatingCloseBtn').addEventListener('click', closeRepeatingModal);
  repeatingOverlay.addEventListener('click', closeRepeatingModal);
  document.getElementById('repeatingNewBtn').addEventListener('click', () => {
    closeRepeatingModal();
    startNewRepeatingGoal();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRepeatingModal(); });

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
          const catInfo = settings.showCategories ? goalDisplayInfo(g) : null;
          if (catInfo) {
            const dot = document.createElement('span');
            dot.className = 'pv-dot';
            dot.style.background = catInfo.color;
            dot.title = catInfo.name;
            span.appendChild(dot);
          }
          if (g.time) {
            const t = document.createElement('span');
            t.className = 'pv-time';
            t.textContent = formatTime(g.time);
            span.appendChild(t);
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
          const dotCats = sortGoals(goals).map(goalDotInfo);
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
    document.querySelectorAll('#subcategoriesEnabledOptions .option-btn').forEach(btn => {
      btn.classList.toggle('active', (btn.dataset.boolValue === 'true') === settings.subcategoriesEnabled);
    });
    document.querySelectorAll('#repeatingEnabledOptions .option-btn').forEach(btn => {
      btn.classList.toggle('active', (btn.dataset.boolValue === 'true') === settings.repeatingEnabled);
    });
  }

  function applyVisibilitySettings() {
    document.getElementById('categoriesBlock').style.display = settings.showCategories ? '' : 'none';
    document.getElementById('categoryDropdown').style.display = settings.showCategories ? '' : 'none';
    document.getElementById('significanceGroup').style.display = settings.showSignificance ? '' : 'none';
    dpCatPicker.style.display = settings.showCategories ? '' : 'none';
    dpStarPicker.style.display = settings.showSignificance ? '' : 'none';
    document.getElementById('repeatGroup').style.display = settings.repeatingEnabled ? '' : 'none';
    document.getElementById('repeatingBtn').style.display = settings.repeatingEnabled ? '' : 'none';
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
      renderDayPreview();
      renderAllGoalsModal();
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
      renderAllGoalsModal();
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
      renderAllGoalsModal();
    });
  });
  document.querySelectorAll('#subgoalsEnabledOptions .option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.subgoalsEnabled = btn.dataset.boolValue === 'true';
      saveSettings();
      renderSettingUI();
      renderSidebarGoals();
      renderDayPreview();
      renderAllGoalsModal();
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
  document.querySelectorAll('#repeatingEnabledOptions .option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.repeatingEnabled = btn.dataset.boolValue === 'true';
      if (!settings.repeatingEnabled) {
        closeRepeatPop(false);
        repeatDraft = null;
        renderRepeatBtn();
      }
      saveSettings();
      renderSettingUI();
      applyVisibilitySettings();
      refreshAfterGoalChange();
    });
  });
  document.querySelectorAll('#subcategoriesEnabledOptions .option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.subcategoriesEnabled = btn.dataset.boolValue === 'true';
      if (!settings.subcategoriesEnabled) {
        expandedChipCategoryIds = new Set();
        subcategoryFormFor = null;
        if (!categoryAddForm.hidden) categoryAddForm.hidden = true;
        // Drop any subcategory the add-goal dropdown had selected, so a
        // stale "Category — Subcategory" label/color doesn't linger, and
        // the next goal created isn't silently tagged with a subcategory
        // the UI no longer lets the user see or pick.
        if (selectedCategoryId) setSelectedCategory(selectedCategoryId, null);
      }
      saveSettings();
      renderSettingUI();
      renderCategoryList();
      renderCategoryDropdown();
      renderSidebarGoals();
      renderDayPreview();
      renderAllGoalsModal();
      renderCalendar();
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
    renderAllGoalsModal();
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
      series = Array.isArray(data.__series) ? data.__series : [];
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
