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

    -- Earlier copies of each user's goals, so a bad save can be undone.
    CREATE TABLE IF NOT EXISTS goals_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      version INTEGER NOT NULL,
      saved_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS goals_history_user ON goals_history (user_id, id);
  `);
  // Every save bumps version; a save must say which version it was based
  // on, so one made from out-of-date goals can't overwrite newer ones.
  const cols = await db.execute('PRAGMA table_info(goals)');
  if (!cols.rows.some(c => c.name === 'version')) {
    await db.execute('ALTER TABLE goals ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
  }
}

// How many earlier copies of each user's goals to keep (at most one an
// hour, plus one before any save that would remove a lot at once).
const HISTORY_KEEP = 72;

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
    db.execute({ sql: 'SELECT data, version FROM goals WHERE user_id = ?', args: [userId] })
      .then(r => r.rows[0]),
  getGoalsVersion: (userId) =>
    db.execute({ sql: 'SELECT version FROM goals WHERE user_id = ?', args: [userId] })
      .then(r => (r.rows[0] ? Number(r.rows[0].version) : 0)),
  // Writes only if the stored version is still `version`, so two saves
  // racing each other can't both win. Resolves to whether it wrote.
  insertGoals: (userId, data) =>
    db.execute({
      sql: `INSERT INTO goals (user_id, data, version, updated_at)
            VALUES (?, ?, 1, datetime('now'))
            ON CONFLICT(user_id) DO NOTHING`,
      args: [userId, data]
    }).then(r => r.rowsAffected === 1),
  updateGoals: (userId, data, version) =>
    db.execute({
      sql: `UPDATE goals SET data = ?, version = version + 1, updated_at = datetime('now')
            WHERE user_id = ? AND version = ?`,
      args: [data, userId, version]
    }).then(r => r.rowsAffected === 1),
  hasRecentSnapshot: (userId) =>
    db.execute({
      sql: `SELECT 1 FROM goals_history WHERE user_id = ? AND saved_at > datetime('now', '-1 hour') LIMIT 1`,
      args: [userId]
    }).then(r => r.rows.length > 0),
  addSnapshot: (userId, data, version) =>
    db.batch([
      { sql: 'INSERT INTO goals_history (user_id, data, version) VALUES (?, ?, ?)', args: [userId, data, version] },
      {
        sql: `DELETE FROM goals_history WHERE user_id = ? AND id NOT IN
                (SELECT id FROM goals_history WHERE user_id = ? ORDER BY id DESC LIMIT ?)`,
        args: [userId, userId, HISTORY_KEEP]
      }
    ], 'write')
};

// ---------- app setup ----------

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
// Matches the 2,000,000-character cap PUT /api/goals enforces itself;
// repeating goals store one entry per day, so payloads can grow past 512kb.
app.use(express.json({ limit: '2mb' }));

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

function parseGoals(text) {
  try { return JSON.parse(text) || {}; } catch (e) { return {}; }
}

function countGoals(goals) {
  return Object.keys(goals).reduce((n, k) =>
    n + (/^\d{4}-\d{2}-\d{2}$/.test(k) && Array.isArray(goals[k]) ? goals[k].length : 0), 0);
}

app.get('/api/goals', requireAuth, async (req, res) => {
  const row = await queries.getGoals(req.session.userId);
  res.json({
    goals: row ? parseGoals(row.data) : {},
    version: row ? Number(row.version) : 0
  });
});

// Cheap check an open page makes now and then, to notice changes saved
// from another tab or device without downloading everything.
app.get('/api/goals/version', requireAuth, async (req, res) => {
  res.json({ version: await queries.getGoalsVersion(req.session.userId) });
});

app.put('/api/goals', requireAuth, async (req, res) => {
  const { goals, baseVersion } = req.body || {};
  if (typeof goals !== 'object' || goals === null || Array.isArray(goals)) {
    return res.status(400).json({ error: 'Malformed goals payload.' });
  }
  const serialized = JSON.stringify(goals);
  if (serialized.length > 2_000_000) {
    return res.status(413).json({ error: 'That is too much data to save at once.' });
  }
  const userId = req.session.userId;

  // A save carries the version it was based on. If anything was saved
  // since (another tab or device), it's refused and handed the current
  // goals instead, so the page can fold its change in and try again,
  // rather than replacing goals it never saw. A page from before versions
  // existed sends none, and is refused the same way.
  const conflict = async () => {
    const row = await queries.getGoals(userId);
    res.status(409).json({
      error: 'Your goals changed somewhere else since this page loaded.',
      goals: row ? parseGoals(row.data) : {},
      version: row ? Number(row.version) : 0
    });
  };
  if (!Number.isInteger(baseVersion) || baseVersion < 0) return conflict();

  const row = await queries.getGoals(userId);
  const current = row ? Number(row.version) : 0;
  if (baseVersion !== current) return conflict();

  if (row) {
    // Keep a copy of what's about to be replaced: once an hour, and always
    // before a save that would remove a lot at once.
    const before = countGoals(parseGoals(row.data));
    const dropsMany = before >= 10 && countGoals(goals) < before / 2;
    if (dropsMany || !(await queries.hasRecentSnapshot(userId))) {
      await queries.addSnapshot(userId, row.data, current);
    }
  }

  const wrote = row
    ? await queries.updateGoals(userId, serialized, current)
    : await queries.insertGoals(userId, serialized);
  if (!wrote) return conflict();
  res.json({ ok: true, version: current + 1 });
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
