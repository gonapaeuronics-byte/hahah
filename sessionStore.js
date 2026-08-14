// sessionStore.js
//
// A small, dependency-free session store for express-session, backed by
// Node's own built-in SQLite support (no native modules to compile).
//
// Sessions are stored server-side in this file. The browser only ever
// holds a random, signed cookie ID — never the session contents.

import session from 'express-session';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';

const { Store } = session;

export class SQLiteSessionStore extends Store {
  constructor({ dir, file = 'sessions.db' }) {
    super();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, file));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid       TEXT PRIMARY KEY,
        data      TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);

    // Clean up expired sessions every 15 minutes.
    setInterval(() => {
      this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    }, 15 * 60 * 1000).unref();
  }

  get(sid, cb) {
    try {
      const row = this.db
        .prepare('SELECT data, expires_at FROM sessions WHERE sid = ?')
        .get(sid);
      if (!row || row.expires_at < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (e) {
      cb(e);
    }
  }

  set(sid, sessionData, cb) {
    try {
      const maxAge = sessionData.cookie?.maxAge || 12 * 60 * 60 * 1000;
      const expiresAt = Date.now() + maxAge;
      this.db
        .prepare(
          `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
        )
        .run(sid, JSON.stringify(sessionData), expiresAt);
      cb && cb();
    } catch (e) {
      cb && cb(e);
    }
  }

  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb && cb();
    } catch (e) {
      cb && cb(e);
    }
  }

  touch(sid, sessionData, cb) {
    this.set(sid, sessionData, cb);
  }
}
