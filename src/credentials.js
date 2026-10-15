import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const credentialsPath = (env = process.env) => env.MC_CREDENTIALS_FILE || join(homedir(), '.config', 'mcskill-afk', 'credentials.json');
const invalid = () => Object.assign(new Error('CREDENTIALS_INVALID'), { code:'CREDENTIALS_INVALID' });
export function validateCredentials(value) {
  if (!value || typeof value.username !== 'string' || !value.username.trim() || value.username.length > 256 ||
      typeof value.password !== 'string' || !value.password || value.password.length > 4096 ||
      !['https://auth.mcskill.ru','https://auth.mcskill.net'].includes(value.authOrigin)) throw invalid();
  return { username:value.username, password:value.password, authOrigin:value.authOrigin };
}
export async function loadCredentials(path = credentialsPath()) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await file.stat();
    if (!info.isFile() || info.size > 32768 || (process.platform !== 'win32' &&
        ((info.mode & 0o077) || info.uid !== process.getuid()))) throw invalid();
    return validateCredentials(JSON.parse(await file.readFile('utf8')));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw invalid(); // Never include a password, JSON fragment or OS error body in logs.
  } finally { await file?.close(); }
}
export async function saveCredentials(value, path = credentialsPath()) {
  const data = validateCredentials(value);
  await mkdir(dirname(path), { recursive:true, mode:0o700 });
  const temp = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  let file;
  try {
    file = await open(temp, 'wx', 0o600);
    // Restrict Windows ACL before writing any secret to the new file.
    if (process.platform === 'win32') await promisify(execFile)('powershell.exe', ['-NoProfile','-NonInteractive','-Command',
      '$a=New-Object System.Security.AccessControl.FileSecurity;$a.SetAccessRuleProtection($true,$false);$u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$a.SetOwner($u);$a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($u,"FullControl","Allow")));Set-Acl -LiteralPath $env:MC_PRIVATE_PATH -AclObject $a'],
      { env:{ ...process.env, MC_PRIVATE_PATH:temp }, windowsHide:true });
    await file.writeFile(JSON.stringify(data) + '\n');
    await file.sync(); await file.close(); file = null;
    await rename(temp, path);
  } catch { throw Object.assign(new Error('CREDENTIALS_SAVE_FAILED'), { code:'CREDENTIALS_SAVE_FAILED' }); }
  finally { await file?.close(); await unlink(temp).catch(() => {}); }
}

export async function acquireAccount({ authOrigin, prompt, login, signal, setup = false, service = false,
  load = loadCredentials, save = saveCredentials }) {
  const existing = setup ? null : await load();
  if (existing) return { credentials:existing };
  if (service) throw Object.assign(new Error('CREDENTIALS_MISSING'), { code:'CREDENTIALS_MISSING' });
  const username = (await prompt('Логин: ')).trim();
  const password = await prompt('Пароль: ', true);
  const shouldSave = /^(y|yes)$/i.test((await prompt('Сохранить логин и пароль в приватном файле? [y/N]: ')).trim());
  const credentials = validateCredentials({username,password,authOrigin});
  const initialSession = await login(username,password,authOrigin,signal);
  if (shouldSave) await save(credentials);
  if (setup && !shouldSave) throw Object.assign(new Error('CREDENTIALS_MISSING'), { code:'CREDENTIALS_MISSING' });
  return { credentials, initialSession, saved:shouldSave };
}
