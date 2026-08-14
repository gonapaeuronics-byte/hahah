// db.js
//
// This file is the ONLY place that talks directly to the database.
// Today that database is SQLite — using Node's own BUILT-IN SQLite
// support (no extra native software to install or compile).
// If you ever move to PostgreSQL later, this is the only file that
// needs to change — nothing else in the app touches SQLite directly.

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Keep the actual database file in server/data/ so it's easy to find,
// back up, or exclude from GitHub (see .gitignore).
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'users.db');

export const db = new DatabaseSync(DB_PATH);

// Create the users table if it doesn't exist yet.
// password_hash stores a bcrypt hash — NEVER the real password.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

export function getUserByUsername(username) {
  return db
    .prepare('SELECT * FROM users WHERE username = ? AND active = 1')
    .get(username);
}

export function createUser(username, passwordHash) {
  return db
    .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(username, passwordHash);
}

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function deactivateUser(username) {
  return db
    .prepare('UPDATE users SET active = 0 WHERE username = ?')
    .run(username);
}
