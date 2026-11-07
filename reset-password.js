#!/usr/bin/env node
// Reset an owner's password from the server's shell.
//   node reset-password.js            -> lists owner accounts
//   node reset-password.js <email>    -> prompts (hidden) for a new password
// Existing login sessions keep working until they expire (14 days).
const fs = require('fs');
const path = require('path');
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
const bcrypt = require('bcryptjs');
const db = require('./db');

const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email) {
  const rows = db.prepare('SELECT o.email, o.name, s.name AS salon FROM owners o JOIN salons s ON s.id = o.salon_id ORDER BY o.id').all();
  if (!rows.length) console.log('No owner accounts exist yet. Register one in the web app first.');
  for (const r of rows) console.log(`${r.email}\t${r.name}\t(${r.salon})`);
  console.log('\nUsage: node reset-password.js <email>');
  process.exit(0);
}
const owner = db.prepare('SELECT id, name FROM owners WHERE email = ?').get(email);
if (!owner) { console.error(`No owner with email ${email}. Run without arguments to list accounts.`); process.exit(1); }

function askHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    if (!stdin.isTTY) { let d = ''; stdin.on('data', (c) => (d += c)).on('end', () => resolve(d.split('\n')[0])); return; }
    let input = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); resolve(input); }
      else if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
      else if (ch === '\u007f' || ch === '\b') input = input.slice(0, -1);
      else input += ch;
    };
    stdin.on('data', onData);
  });
}

(async () => {
  const pw = await askHidden(`New password for ${owner.name} <${email}>: `);
  if (pw.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }
  if (process.stdin.isTTY && (await askHidden('Repeat it: ')) !== pw) { console.error('Passwords do not match.'); process.exit(1); }
  db.prepare('UPDATE owners SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(pw, 10), owner.id);
  console.log('Password updated.');
})();
