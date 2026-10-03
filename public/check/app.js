(function () {
  let items = [];
  let streak = { current: 0, longest: 0 };
  let currentLocalDate = localDateString();
  let wasCompleteToday = false;
  let busy = false;

  const loadingState = document.getElementById('loadingState');
  const appContent = document.getElementById('appContent');
  const checklistEl = document.getElementById('checklist');
  const progressFill = document.getElementById('progressFill');
  const hypeText = document.getElementById('hypeText');
  const streakBadge = document.getElementById('streakBadge');
  const todayDate = document.getElementById('todayDate');
  const accountLabel = document.getElementById('accountLabel');
  const addItemForm = document.getElementById('addItemForm');
  const addItemInput = document.getElementById('addItemInput');
  const addItemBtn = document.getElementById('addItemBtn');
  const toast = document.getElementById('toast');

  function localDateString(d) {
    d = d || new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('visible'), 3200);
  }

  function apiUrl(path) {
    const sep = path.includes('?') ? '&' : '?';
    return path + sep + 'localDate=' + encodeURIComponent(currentLocalDate);
  }

  async function api(path, options) {
    const res = await fetch(apiUrl(path), options);
    if (res.status === 401) {
      window.location.href = '/check/login.html';
      throw new Error('Not signed in');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Something went wrong.');
    return body;
  }

  // ---------- hype text ----------
  function hypeMessage(checkedCount, total) {
    if (!total) return "Add your first thing below — anything counts. 👇";
    const pct = checkedCount / total;
    if (pct === 0) return "Let's get this bread. 🍞";
    if (pct < 0.5) return "Nice start — keep going. ⚡";
    if (pct < 1) return "You're crushing it. 🔥";
    return 'LEGENDARY. Everything’s checked off! 🎉';
  }

  // ---------- confetti ----------
  function burstConfetti() {
    const colors = ['#FF3E8E', '#6C4CF1', '#FFC93C', '#17D9A3', '#3EC9FF'];
    const count = 60;
    for (let i = 0; i < count; i++) {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.left = Math.random() * 100 + 'vw';
      piece.style.background = colors[Math.floor(Math.random() * colors.length)];
      piece.style.animationDuration = (2.2 + Math.random() * 1.4) + 's';
      piece.style.animationDelay = (Math.random() * 0.4) + 's';
      piece.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
      document.body.appendChild(piece);
      setTimeout(() => piece.remove(), 4200);
    }
  }

  // ---------- rendering ----------
  function render() {
    const total = items.length;
    const checkedCount = items.filter(i => i.checked).length;
    const pct = total ? Math.round((checkedCount / total) * 100) : 0;

    progressFill.style.width = pct + '%';
    progressFill.classList.toggle('complete', total > 0 && checkedCount === total);
    hypeText.textContent = hypeMessage(checkedCount, total);

    if (streak.current > 0) {
      streakBadge.hidden = false;
      streakBadge.textContent = '🔥 ' + streak.current + '-day streak';
    } else {
      streakBadge.hidden = true;
    }

    const nowComplete = total > 0 && checkedCount === total;
    if (nowComplete && !wasCompleteToday) burstConfetti();
    wasCompleteToday = nowComplete;

    checklistEl.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'checklist-empty';
      empty.innerHTML = '<span class="big-emoji">📝</span>Nothing on the list yet.<br>Add the first thing below.';
      checklistEl.appendChild(empty);
      return;
    }

    items.forEach((item, idx) => {
      checklistEl.appendChild(buildItemRow(item, idx));
    });
  }

  function buildItemRow(item, idx) {
    const row = document.createElement('div');
    row.className = 'check-item' + (item.checked ? ' done' : '');

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'check-item-toggle' + (item.checked ? ' checked' : '');
    toggle.innerHTML = item.checked ? '&#10003;' : '';
    toggle.setAttribute('aria-label', item.checked ? 'Mark as not done' : 'Mark as done');
    toggle.addEventListener('click', () => toggleItem(item));

    const text = document.createElement('div');
    text.className = 'check-item-text';
    text.textContent = item.text;

    const actions = document.createElement('div');
    actions.className = 'check-item-actions';

    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'item-icon-btn';
    up.innerHTML = '&#9650;';
    up.setAttribute('aria-label', 'Move up');
    up.disabled = idx === 0;
    up.addEventListener('click', () => moveItem(idx, -1));

    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'item-icon-btn';
    down.innerHTML = '&#9660;';
    down.setAttribute('aria-label', 'Move down');
    down.disabled = idx === items.length - 1;
    down.addEventListener('click', () => moveItem(idx, 1));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'item-icon-btn remove';
    remove.innerHTML = '&#10005;';
    remove.setAttribute('aria-label', 'Delete');
    remove.addEventListener('click', () => removeItem(item));

    actions.appendChild(up);
    actions.appendChild(down);
    actions.appendChild(remove);

    row.appendChild(toggle);
    row.appendChild(text);
    row.appendChild(actions);
    return row;
  }

  // ---------- actions ----------
  async function toggleItem(item) {
    const previous = item.checked;
    item.checked = !item.checked;
    render();
    try {
      await api('/api/checklist/items/' + item.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checked: item.checked, localDate: currentLocalDate })
      });
    } catch (e) {
      item.checked = previous;
      render();
      showToast(e.message);
    }
  }

  async function removeItem(item) {
    const idx = items.indexOf(item);
    if (idx === -1) return;
    items.splice(idx, 1);
    render();
    try {
      await api('/api/checklist/items/' + item.id, { method: 'DELETE' });
    } catch (e) {
      showToast(e.message);
      await loadChecklist();
    }
  }

  async function moveItem(idx, direction) {
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= items.length) return;
    const tmp = items[idx];
    items[idx] = items[swapIdx];
    items[swapIdx] = tmp;
    render();
    try {
      await api('/api/checklist/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: items.map(i => i.id) })
      });
    } catch (e) {
      showToast(e.message);
      await loadChecklist();
    }
  }

  addItemForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = addItemInput.value.trim();
    if (!text || busy) return;
    busy = true;
    addItemBtn.disabled = true;
    try {
      const body = await api('/api/checklist/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, localDate: currentLocalDate })
      });
      items.push(body.item);
      addItemInput.value = '';
      render();
    } catch (e) {
      showToast(e.message);
    } finally {
      busy = false;
      addItemBtn.disabled = false;
      addItemInput.focus();
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/check/login.html';
  });

  // ---------- date rollover while the tab stays open ----------
  function watchForRollover() {
    setInterval(async () => {
      const freshDate = localDateString();
      if (freshDate !== currentLocalDate) {
        currentLocalDate = freshDate;
        await loadChecklist();
        showToast('✨ New day, fresh list!');
      }
    }, 60 * 1000);
  }

  async function loadChecklist() {
    const body = await api('/api/checklist');
    items = body.items || [];
    streak = body.streak || { current: 0, longest: 0 };
    wasCompleteToday = items.length > 0 && items.every(i => i.checked);
    render();
  }

  // ---------- startup ----------
  (async function start() {
    try {
      const meRes = await fetch('/api/me');
      const me = await meRes.json();
      if (!me.signedIn) { window.location.href = '/check/login.html'; return; }
      accountLabel.textContent = me.name || me.email;

      todayDate.textContent = new Date().toLocaleDateString(undefined, {
        weekday: 'long', month: 'long', day: 'numeric'
      });

      await loadChecklist();
      watchForRollover();
    } catch (e) {
      console.error('Could not load Check!', e);
      showToast('Could not load your list. Try refreshing.');
    } finally {
      loadingState.style.display = 'none';
      appContent.hidden = false;
    }
  })();
})();
