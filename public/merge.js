// Three-way merge of a user's goals, for when they were saved from two
// places at once (two tabs, a laptop and a phone).
//
//   base   - the goals as this page last loaded or saved them
//   mine   - the goals in this page now
//   theirs - the goals the server has now, saved from somewhere else
//
// Goals are matched by id across every day, so a goal moved to another day
// on one side and edited on the other ends up moved *and* edited. Whoever
// changed something wins; when both changed the same goal, it's merged
// field by field, with this page winning where both changed the same field.
// A change always beats a delete, so an edit is never silently dropped.
(function (root) {
  const DAY = '\u0000day';     // carries a goal's date while it's being merged
  const VALUE = '\u0000value'; // carries anything in a day's list that isn't an object
  const isDateKey = k => /^\d{4}-\d{2}-\d{2}$/.test(k);

  // JSON with object keys sorted, so equal things compare equal no matter
  // what order their keys were written in.
  function stable(v) {
    if (v === undefined) return 'undefined';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  function same(a, b) { return stable(a) === stable(b); }

  // One item as base / mine / theirs, any of them possibly missing.
  // Returns the merged item, or null if it should be gone.
  function mergeItem(b, m, t) {
    if (b === undefined) return m !== undefined ? m : (t !== undefined ? t : null);
    if (same(m, b)) return t !== undefined ? t : null;
    if (same(t, b)) return m !== undefined ? m : null;
    if (m === undefined) return t; // deleted here, edited there: keep the edit
    if (t === undefined) return m; // edited here, deleted there: keep the edit
    if (typeof m !== 'object' || typeof t !== 'object' || !m || !t || Array.isArray(m) || Array.isArray(t)) return m;
    const out = {};
    new Set([...Object.keys(b || {}), ...Object.keys(m), ...Object.keys(t)]).forEach(k => {
      const v = same(m[k], b && b[k]) ? t[k] : m[k];
      if (v !== undefined) out[k] = v;
    });
    return out;
  }

  // Both orders combined: `primary` as-is, with anything only in
  // `secondary` slotted in just after whatever came before it there.
  function mergeOrder(primary, secondary) {
    const out = primary.slice();
    const seen = new Set(out);
    let at = -1;
    secondary.forEach(k => {
      if (seen.has(k)) { at = out.indexOf(k); return; }
      out.splice(at + 1, 0, k);
      seen.add(k);
      at++;
    });
    return out;
  }

  // A list's items keyed by id (by position for any without one), in order.
  function keyed(list, prefix, taken) {
    const map = new Map(), order = [];
    (Array.isArray(list) ? list : []).forEach((item, i) => {
      let key = item && typeof item === 'object' && item.id != null ? 'id:' + item.id : prefix + i;
      while (map.has(key) || (taken && taken.has(key))) key += '+'; // a repeated id stays its own item
      map.set(key, item);
      order.push(key);
    });
    return { map, order };
  }

  // Lists of things with ids, like categories or recurring goals.
  function mergeList(b, m, t) {
    const B = keyed(b, 'pos:'), M = keyed(m, 'pos:'), T = keyed(t, 'pos:');
    const order = same(M.order, B.order) ? mergeOrder(T.order, M.order) : mergeOrder(M.order, T.order);
    const out = [];
    order.forEach(k => {
      const v = mergeItem(B.map.get(k), M.map.get(k), T.map.get(k));
      if (v !== null) out.push(v);
    });
    return out;
  }

  function mergeMap(b, m, t) {
    b = b || {}; m = m || {}; t = t || {};
    const out = {};
    new Set([...Object.keys(m), ...Object.keys(t)]).forEach(k => {
      const v = same(m[k], b[k]) ? t[k] : m[k];
      if (v !== undefined) out[k] = v;
    });
    return out;
  }

  // Every goal in a blob, keyed across all days, each tagged with its day.
  function goalsOf(blob) {
    const map = new Map(), dayOrder = {};
    Object.keys(blob || {}).filter(isDateKey).sort().forEach(day => {
      const list = keyed(blob[day], 'pos:' + day + ':', map);
      dayOrder[day] = list.order;
      list.order.forEach(k => {
        const g = list.map.get(k);
        map.set(k, Object.assign({ [DAY]: day }, g && typeof g === 'object' && !Array.isArray(g) ? g : { [VALUE]: g }));
      });
    });
    return { map, dayOrder };
  }
  function unwrap(v) {
    if (Object.prototype.hasOwnProperty.call(v, VALUE)) return v[VALUE];
    const g = Object.assign({}, v);
    delete g[DAY];
    return g;
  }

  function mergeGoals(b, m, t) {
    const B = goalsOf(b), M = goalsOf(m), T = goalsOf(t);
    const merged = new Map();
    new Set([...M.map.keys(), ...T.map.keys()]).forEach(k => {
      const v = mergeItem(B.map.get(k), M.map.get(k), T.map.get(k));
      if (v !== null) merged.set(k, v);
    });
    const out = {};
    new Set([...Object.keys(M.dayOrder), ...Object.keys(T.dayOrder)]).forEach(day => {
      const mo = M.dayOrder[day] || [], to = T.dayOrder[day] || [];
      const order = same(mo, B.dayOrder[day] || []) ? mergeOrder(to, mo) : mergeOrder(mo, to);
      out[day] = [];
      order.forEach(k => {
        const v = merged.get(k);
        if (v && v[DAY] === day) { out[day].push(unwrap(v)); merged.delete(k); }
      });
    });
    // Anything not placed yet (moved to a day neither order expected) goes there.
    merged.forEach(v => { (out[v[DAY]] = out[v[DAY]] || []).push(unwrap(v)); });
    return out;
  }

  function mergeData(base, mine, theirs) {
    base = base || {}; mine = mine || {}; theirs = theirs || {};
    const out = mergeGoals(base, mine, theirs);
    new Set([...Object.keys(mine), ...Object.keys(theirs)].filter(k => !isDateKey(k))).forEach(k => {
      let v;
      if (k === '__categories' || k === '__series') v = mergeList(base[k], mine[k], theirs[k]);
      else if (k === '__customOrder') v = mergeMap(base[k], mine[k], theirs[k]);
      else v = same(mine[k], base[k]) ? theirs[k] : mine[k];
      if (v !== undefined) out[k] = v;
    });
    return out;
  }

  const api = { mergeData };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GoalkeeprMerge = api;
})(this);
