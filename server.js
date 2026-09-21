// Goal Calendar — server
//
// A small, self-contained web app: email/password accounts, each user's
// goals stored privately in a database. No third-party auth provider
// required.

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

if (SESSION_SECRET === 'dev-secret-change-me') {
  console.warn(
    '\n[warning] Using the default SESSION_SECRET. Set a real SESSION_SECRET ' +
    'environment variable before deploying publicly, or sessions can be forged.\n'
  );
}

// ---------- database ----------
//
// Uses Turso (hosted libSQL) when TURSO_DATABASE_URL is set, so data
// survives redeploys on hosts with an ephemeral filesystem (e.g. Render's
// free tier). Falls back to a local SQLite file for local development, so
// nothing extra is required to run this on your own machine.

const db = createClient(
  process.env.TURSO_DATABASE_URL
    ? { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }
    : { url: 'file:' + path.join(__dirname, 'data.sqlite') }
);

if (process.env.TURSO_DATABASE_URL && !process.env.TURSO_AUTH_TOKEN) {
  console.warn('\n[warning] TURSO_DATABASE_URL is set but TURSO_AUTH_TOKEN is not.\n');
}

async function initDb() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS goals (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      checked INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS checklist_state (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      last_reset_date TEXT NOT NULL,
      current_streak INTEGER NOT NULL DEFAULT 0,
      longest_streak INTEGER NOT NULL DEFAULT 0
    );
  `);
}

const queries = {
  findUserByEmail: (email) =>
    db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] })
      .then(r => r.rows[0]),
  findUserById: (id) =>
    db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] })
      .then(r => r.rows[0]),
  createUser: (email, passwordHash, name) =>
    db.execute({
      sql: 'INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)',
      args: [email, passwordHash, name]
    }).then(r => Number(r.lastInsertRowid)),
  getGoals: (userId) =>
    db.execute({ sql: 'SELECT data FROM goals WHERE user_id = ?', args: [userId] })
      .then(r => r.rows[0]),
  upsertGoals: (userId, data) =>
    db.execute({
      sql: `INSERT INTO goals (user_id, data, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      args: [userId, data]
    }),
  checklist: {
    getState: (userId) =>
      db.execute({ sql: 'SELECT * FROM checklist_state WHERE user_id = ?', args: [userId] })
        .then(r => r.rows[0]),
    upsertState: (userId, lastResetDate, currentStreak, longestStreak) =>
      db.execute({
        sql: `INSERT INTO checklist_state (user_id, last_reset_date, current_streak, longest_streak)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET last_reset_date = excluded.last_reset_date,
                current_streak = excluded.current_streak, longest_streak = excluded.longest_streak`,
        args: [userId, lastResetDate, currentStreak, longestStreak]
      }),
    getItems: (userId) =>
      db.execute({
        sql: 'SELECT * FROM checklist_items WHERE user_id = ? ORDER BY position ASC, id ASC',
        args: [userId]
      }).then(r => r.rows),
    insertItem: (userId, text, position) =>
      db.execute({
        sql: 'INSERT INTO checklist_items (user_id, text, position) VALUES (?, ?, ?)',
        args: [userId, text, position]
      }).then(r => Number(r.lastInsertRowid)),
    deleteItem: (userId, id) =>
      db.execute({ sql: 'DELETE FROM checklist_items WHERE user_id = ? AND id = ?', args: [userId, id] }),
    resetAllChecked: (userId) =>
      db.execute({ sql: 'UPDATE checklist_items SET checked = 0 WHERE user_id = ?', args: [userId] }),
    counts: (userId) =>
      db.execute({
        sql: 'SELECT COUNT(*) as total, COALESCE(SUM(checked), 0) as checkedCount FROM checklist_items WHERE user_id = ?',
        args: [userId]
      }).then(r => r.rows[0]),
    maxPosition: (userId) =>
      db.execute({
        sql: 'SELECT COALESCE(MAX(position), -1) as maxPos FROM checklist_items WHERE user_id = ?',
        args: [userId]
      }).then(r => Number(r.rows[0].maxPos))
  }
};

// ---------- checklist reset / streak logic ----------
//
// Check! keeps the same items from day to day, but their checkmarks clear
// once per calendar day. The client tells us what day it thinks it is (its
// own local date, so the reset lines up with the user's midnight rather
// than the server's) and we roll the reset forward the next time they touch
// the API, rather than relying on a cron job.

function isValidLocalDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function todayUtcDateString() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(earlier, later) {
  const a = Date.parse(earlier + 'T00:00:00Z');
  const b = Date.parse(later + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

async function ensureChecklistReset(userId, localDate) {
  const today = isValidLocalDate(localDate) ? localDate : todayUtcDateString();
  const state = await queries.checklist.getState(userId);

  if (!state) {
    await queries.checklist.upsertState(userId, today, 0, 0);
    return { resetDate: today, streak: { current: 0, longest: 0 } };
  }

  if (state.last_reset_date === today) {
    return { resetDate: today, streak: { current: state.current_streak, longest: state.longest_streak } };
  }

  // A new day has arrived since we last checked in. Before wiping today's
  // checkmarks, decide whether the day we're leaving behind keeps or breaks
  // the streak.
  const counts = await queries.checklist.counts(userId);
  const total = Number(counts.total) || 0;
  const checkedCount = Number(counts.checkedCount) || 0;
  const wasFullyCompleted = total > 0 && checkedCount === total;

  let currentStreak = 0;
  if (wasFullyCompleted) {
    const gap = daysBetween(state.last_reset_date, today);
    currentStreak = gap === 1 ? (state.current_streak || 0) + 1 : 1;
  }
  const longestStreak = Math.max(state.longest_streak || 0, currentStreak);

  await queries.checklist.resetAllChecked(userId);
  await queries.checklist.upsertState(userId, today, currentStreak, longestStreak);

  return { resetDate: today, streak: { current: currentStreak, longest: longestStreak } };
}

function formatChecklistItem(row) {
  return { id: row.id, text: row.text, checked: !!row.checked, position: row.position };
}

// ---------- app setup ----------

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '512kb' }));

app.use(
  cookieSession({
    name: 'session',
    secret: SESSION_SECRET,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  })
);

// very small in-memory rate limiter for login/register attempts per IP
const attempts = new Map();
function rateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const max = 20;
  const entry = attempts.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count++;
  attempts.set(key, entry);
  if (entry.count > max) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not signed in.' });
  }
  next();
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ---------- auth API ----------

app.post('/api/register', rateLimit, async (req, res) => {
  const { email, password, name } = req.body || {};

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const cleanName = (typeof name === 'string' ? name.trim() : '').slice(0, 60) || email.split('@')[0];
  const cleanEmail = email.trim().toLowerCase();

  const existing = await queries.findUserByEmail(cleanEmail);
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const userId = await queries.createUser(cleanEmail, passwordHash, cleanName);
  req.session.userId = userId;

  res.json({ ok: true, name: cleanName });
});

app.post('/api/login', rateLimit, async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email) || typeof password !== 'string') {
    return res.status(400).json({ error: 'Enter your email and password.' });
  }
  const user = await queries.findUserByEmail(email.trim().toLowerCase());
  if (!user) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  req.session.userId = user.id;
  res.json({ ok: true, name: user.name });
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.json({ signedIn: false });
  }
  const user = await queries.findUserById(req.session.userId);
  if (!user) {
    req.session = null;
    return res.json({ signedIn: false });
  }
  res.json({ signedIn: true, name: user.name, email: user.email });
});

// ---------- goals API ----------

app.get('/api/goals', requireAuth, async (req, res) => {
  const row = await queries.getGoals(req.session.userId);
  let goals = {};
  if (row) {
    try {
      goals = JSON.parse(row.data) || {};
    } catch (e) {
      goals = {};
    }
  }
  res.json({ goals });
});

app.put('/api/goals', requireAuth, async (req, res) => {
  const { goals } = req.body || {};
  if (typeof goals !== 'object' || goals === null || Array.isArray(goals)) {
    return res.status(400).json({ error: 'Malformed goals payload.' });
  }
  const serialized = JSON.stringify(goals);
  if (serialized.length > 2_000_000) {
    return res.status(413).json({ error: 'That is too much data to save at once.' });
  }
  await queries.upsertGoals(req.session.userId, serialized);
  res.json({ ok: true });
});

// ---------- checklist API (Check!) ----------

app.get('/api/checklist', requireAuth, async (req, res) => {
  const { resetDate, streak } = await ensureChecklistReset(req.session.userId, req.query.localDate);
  const items = await queries.checklist.getItems(req.session.userId);
  res.json({ items: items.map(formatChecklistItem), resetDate, streak });
});

app.post('/api/checklist/items', requireAuth, async (req, res) => {
  const { text, localDate } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Give this item some text.' });
  }
  const cleanText = text.trim().slice(0, 200);

  await ensureChecklistReset(req.session.userId, localDate);

  const counts = await queries.checklist.counts(req.session.userId);
  if (Number(counts.total) >= 500) {
    return res.status(413).json({ error: "That's a lot to check off! Clear out some old items first." });
  }

  const nextPosition = (await queries.checklist.maxPosition(req.session.userId)) + 1;
  const id = await queries.checklist.insertItem(req.session.userId, cleanText, nextPosition);
  res.json({ ok: true, item: { id, text: cleanText, checked: false, position: nextPosition } });
});

app.patch('/api/checklist/items/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid item.' });
  const { checked, text, localDate } = req.body || {};

  await ensureChecklistReset(req.session.userId, localDate);

  const fields = [];
  const args = [];
  if (typeof checked === 'boolean') { fields.push('checked = ?'); args.push(checked ? 1 : 0); }
  if (typeof text === 'string' && text.trim()) { fields.push('text = ?'); args.push(text.trim().slice(0, 200)); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

  args.push(req.session.userId, id);
  const result = await db.execute({
    sql: `UPDATE checklist_items SET ${fields.join(', ')} WHERE user_id = ? AND id = ?`,
    args
  });
  if (result.rowsAffected === 0) return res.status(404).json({ error: 'Item not found.' });
  res.json({ ok: true });
});

app.delete('/api/checklist/items/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid item.' });
  await queries.checklist.deleteItem(req.session.userId, id);
  res.json({ ok: true });
});

app.put('/api/checklist/reorder', requireAuth, async (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order) || !order.length || order.some(id => !Number.isInteger(id))) {
    return res.status(400).json({ error: 'Malformed order.' });
  }
  if (order.length > 500) return res.status(413).json({ error: 'Too many items to reorder at once.' });
  for (let i = 0; i < order.length; i++) {
    await db.execute({
      sql: 'UPDATE checklist_items SET position = ? WHERE user_id = ? AND id = ?',
      args: [i, req.session.userId, order[i]]
    });
  }
  res.json({ ok: true });
});

// ---------- pages ----------

const PUBLIC_DIR = path.join(__dirname, 'public');

app.get('/', (req, res) => {
  // Always show the landing page on "/", even for signed-in users, instead
  // of redirecting straight into the app.
  res.sendFile(path.join(PUBLIC_DIR, 'landing.html'));
});

app.get('/app.html', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login.html');
  }
  res.sendFile(path.join(PUBLIC_DIR, 'app.html'));
});

app.get('/check', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'check', 'landing.html'));
});

app.get('/check/app.html', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.redirect('/check/login.html');
  }
  res.sendFile(path.join(PUBLIC_DIR, 'check', 'app.html'));
});

app.use(express.static(PUBLIC_DIR));

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Goal Calendar running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
