// Goal Calendar — server
//
// A small, self-contained web app: email/password accounts, each user's
// goals stored privately in a local SQLite database. No third-party
// auth provider required.

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

if (SESSION_SECRET === 'dev-secret-change-me') {
  console.warn(
    '\n[warning] Using the default SESSION_SECRET. Set a real SESSION_SECRET ' +
    'environment variable before deploying publicly, or sessions can be forged.\n'
  );
}

// ---------- database ----------

const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
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
`);

const stmts = {
  findUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  findUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  createUser: db.prepare(
    'INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)'
  ),
  getGoals: db.prepare('SELECT data FROM goals WHERE user_id = ?'),
  upsertGoals: db.prepare(`
    INSERT INTO goals (user_id, data, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `)
};

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

  const existing = stmts.findUserByEmail.get(cleanEmail);
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const info = stmts.createUser.run(cleanEmail, passwordHash, cleanName);
  req.session.userId = info.lastInsertRowid;

  res.json({ ok: true, name: cleanName });
});

app.post('/api/login', rateLimit, async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email) || typeof password !== 'string') {
    return res.status(400).json({ error: 'Enter your email and password.' });
  }
  const user = stmts.findUserByEmail.get(email.trim().toLowerCase());
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

app.get('/api/me', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.json({ signedIn: false });
  }
  const user = stmts.findUserById.get(req.session.userId);
  if (!user) {
    req.session = null;
    return res.json({ signedIn: false });
  }
  res.json({ signedIn: true, name: user.name, email: user.email });
});

// ---------- goals API ----------

app.get('/api/goals', requireAuth, (req, res) => {
  const row = stmts.getGoals.get(req.session.userId);
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

app.put('/api/goals', requireAuth, (req, res) => {
  const { goals } = req.body || {};
  if (typeof goals !== 'object' || goals === null || Array.isArray(goals)) {
    return res.status(400).json({ error: 'Malformed goals payload.' });
  }
  const serialized = JSON.stringify(goals);
  if (serialized.length > 2_000_000) {
    return res.status(413).json({ error: 'That is too much data to save at once.' });
  }
  stmts.upsertGoals.run(req.session.userId, serialized);
  res.json({ ok: true });
});

// ---------- pages ----------

const PUBLIC_DIR = path.join(__dirname, 'public');

app.get('/', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect('/app.html');
  }
  res.sendFile(path.join(PUBLIC_DIR, 'landing.html'));
});

app.get('/app.html', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login.html');
  }
  res.sendFile(path.join(PUBLIC_DIR, 'app.html'));
});

app.use(express.static(PUBLIC_DIR));

app.listen(PORT, () => {
  console.log(`Goal Calendar running at http://localhost:${PORT}`);
});
