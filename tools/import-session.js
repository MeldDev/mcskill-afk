import { readFile, writeFile, readdir, stat, rename, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// Java argument-file quoting. Never evaluate arguments or launch commands from them.
export function tokenize(text) {
  const out = []; let word = '', quote = '', active = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!quote && /\s/.test(c)) { if (active) out.push(word); word = ''; active = false; continue; }
    if (!quote && c === '#' && !active) { while (i < text.length && text[i] !== '\n') i++; continue; }
    active = true;
    if (c === '"' || c === "'") { if (quote === c) quote = ''; else if (!quote) quote = c; else word += c; }
    else if (quote && c === '\\' && ['\\', '"', "'"].includes(text[i + 1])) word += text[++i];
    else word += c;
  }
  if (quote) throw new Error('Invalid argument file');
  if (active) out.push(word); return out;
}
export function extract(text) {
  const a = tokenize(text.replace(/^\uFEFF/, '')), s = {};
  for (let i = 0; i < a.length; i++) for (const [arg, key] of [['--username','username'],['--uuid','uuid'],['--accessToken','accessToken']]) {
    if (a[i] === arg) s[key] = a[++i]; else if (a[i].startsWith(arg + '=')) s[key] = a[i].slice(arg.length + 1);
  }
  if (!/^[A-Za-z0-9_]{1,16}$/.test(s.username || '') || !/^[a-fA-F0-9-]{32,36}$/.test(s.uuid || '') || !s.accessToken || s.accessToken.length > 8192) throw new Error('Missing session fields');
  return s;
}
async function main() {
  let input = process.argv[2]; const output = resolve(process.argv[3] || 'session.json');
  if (!input || input === '--latest') {
    const files = await Promise.all((await readdir(tmpdir())).filter(n => /^mc-launch-.*\.args$/.test(n)).map(async n => ({ path: join(tmpdir(), n), time: (await stat(join(tmpdir(), n))).mtimeMs })));
    input = files.sort((a,b) => b.time - a.time)[0]?.path;
  }
  if (!input) throw new Error('Launcher args not found');
  const info = await stat(input); if (info.size > 1048576) throw new Error('Args file too large');
  const s = extract(await readFile(input, 'utf8'));
  const temp = output + '.' + randomBytes(6).toString('hex') + '.tmp';
  await writeFile(temp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temp, output); if (process.platform !== 'win32') await chmod(output, 0o600);
  console.log('Session imported. No credentials printed. Keep this file private.');
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => { console.error('Session import failed. Check input, output directory and launcher session.'); process.exitCode = 1; });
}
