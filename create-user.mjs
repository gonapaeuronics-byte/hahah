// create-user.mjs
//
// A simple command-line tool for adding a login account.
// This is how you add each of your 5 logins — no code changes needed,
// just run this once per person.
//
// Usage (from inside the server/ folder):
//   node create-user.mjs
//
// It will ask you for a username and password, one at a time.

import readline from 'readline';
import { hashPassword } from './auth.js';
import { createUser, countUsers } from './db.js';

const MAX_USERS = 5;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function main() {
  const existing = countUsers();
  console.log(`Currently ${existing} account(s) exist (limit: ${MAX_USERS}).`);

  if (existing >= MAX_USERS) {
    console.error(
      `❌ You already have ${MAX_USERS} accounts. Deactivate one first if you need to add another.`
    );
    rl.close();
    return;
  }

  const username = (await ask('New username: ')).trim();
  const password = await ask('New password: ');

  if (!username || !password) {
    console.error('❌ Username and password cannot be empty.');
    rl.close();
    return;
  }

  if (password.length < 8) {
    console.error('❌ Please use a password of at least 8 characters.');
    rl.close();
    return;
  }

  try {
    const hash = await hashPassword(password);
    createUser(username, hash);
    console.log(`✅ Account created for "${username}". They can now log in.`);
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      console.error(`❌ Username "${username}" already exists.`);
    } else {
      console.error('❌ Failed to create account:', e.message);
    }
  }

  rl.close();
}

main();
