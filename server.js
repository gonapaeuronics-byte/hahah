// server.js
//
// This is the small backend for the Euronics Digital Command Centre.
// It does exactly four things:
//   POST /login     - check username/password, start a session
//   POST /logout     - end the session
//   GET  /api/me     - "am I logged in?" (used by the frontend)
//   GET  /api/data   - return bank.json contents, ONLY if logged in
//
// It does NOT touch the TMR pipeline, sync-data.mjs, or the
// GitHub Actions workflow. It only reads the bank.json file that
// those already produce.

import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { verifyLogin } from './auth.js';
import { SQLiteSessionStore } from './sessionStore.js';
import {
  requireLogin,
  loginRateLimit,
  recordFailedLogin,
  clearFailedLogins
} from './middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.set('trust proxy', 1); // needed on Render so req.ip and "Secure" cookies work correctly

const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// The frontend (Netlify) lives on a different domain than this backend
// (Render). ALLOWED_ORIGIN tells the browser "it's OK for THIS specific
// website to make logged-in requests to me." Set this in Render's
// environment variables to your real Netlify URL, e.g.
// https://euronics-dashboard.netlify.app
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:8888';

app.use(express.json());

// ── CORS: allow the dashboard's exact domain to send cookies ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Sessions: stored server-side in SQLite, never in the browser ──
app.use(
  session({
    store: new SQLiteSessionStore({
      dir: path.join(__dirname, 'data')
    }),
    name: 'euronics_sid',
    secret: process.env.SESSION_SECRET, // required — see .env.example
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true, // JavaScript in the browser can NEVER read this cookie
      secure: IS_PRODUCTION, // only sent over HTTPS in production
      sameSite: IS_PRODUCTION ? 'none' : 'lax', // 'none' needed for cross-domain (Netlify <-> Render)
      maxAge: 12 * 60 * 60 * 1000 // 12 hours
    }
  })
);

if (!process.env.SESSION_SECRET) {
  console.error(
    '❌ SESSION_SECRET is not set. Refusing to start — see .env.example.'
  );
  process.exit(1);
}

// ── Where bank.json actually lives ──
// The backend reads the SAME file the GitHub Action already writes to,
// directly from the repository checkout on Render. It is never served
// as a plain public file — only handed back through this API, and only
// to logged-in sessions.
const BANK_JSON_PATH =
  process.env.BANK_JSON_PATH || path.join(__dirname, '..', 'data', 'bank.json');

// ── Routes ──

app.post('/login', loginRateLimit, async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = await verifyLogin(username, password);

  if (!user) {
    recordFailedLogin(req.ip);
    // Deliberately vague — never reveal whether the username exists.
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  clearFailedLogins(req.ip);

  // Regenerate the session on login to prevent session fixation attacks.
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Login failed, please try again' });
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ ok: true, username: user.username });
  });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('euronics_sid');
    res.json({ ok: true });
  });
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.userId) {
    return res.json({ loggedIn: true, username: req.session.username });
  }
  res.json({ loggedIn: false });
});

app.get('/api/data', requireLogin, (req, res) => {
  fs.readFile(BANK_JSON_PATH, 'utf8', (err, raw) => {
    if (err) {
      console.error('Failed to read bank.json:', err.message);
      return res.status(500).json({ error: 'Data temporarily unavailable' });
    }
    res.type('application/json').send(raw);
  });
});

app.listen(PORT, () => {
  console.log(`Euronics dashboard backend running on port ${PORT}`);
  console.log(`Allowed frontend origin: ${ALLOWED_ORIGIN}`);
});
