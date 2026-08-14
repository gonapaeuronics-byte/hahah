// auth.js
//
// This file handles turning a real password into a safe hash to store,
// and later checking a typed-in password against that stored hash.
// The real password is NEVER saved anywhere — only its bcrypt hash.

import bcrypt from 'bcryptjs';
import { getUserByUsername } from './db.js';

const SALT_ROUNDS = 12; // Standard, secure default for bcrypt.

export async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

// Returns the user object if username + password are correct.
// Returns null if either the username doesn't exist OR the password is
// wrong — deliberately the SAME response either way, so a wrong login
// attempt can't be used to figure out which usernames are real.
export async function verifyLogin(username, plainPassword) {
  const user = getUserByUsername(username);
  if (!user) {
    // Still run a bcrypt compare against a dummy hash so that a
    // "user not found" response doesn't return faster than a
    // "wrong password" response (timing side-channel protection).
    await bcrypt.compare(plainPassword, '$2a$12$invalidsaltinvalidsaltin');
    return null;
  }

  const ok = await bcrypt.compare(plainPassword, user.password_hash);
  if (!ok) return null;

  return { id: user.id, username: user.username };
}
