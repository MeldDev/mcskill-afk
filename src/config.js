import { readFile, stat } from 'node:fs/promises';
export class ConfigError extends Error { constructor(message) { super(message); this.code = 'CONFIG'; this.retryable = false; } }
const number = (e, name, fallback, min, max) => {
  const n = Number(e[name] ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`Invalid ${name}`);
  return n;
};
export function config(e = process.env) {
  const authOrigin = e.MCSKILL_AUTH_ORIGIN || 'https://auth.mcskill.ru';
  if (!['https://auth.mcskill.ru', 'https://auth.mcskill.net'].includes(authOrigin)) throw new ConfigError('Auth origin must be an official MCSkill HTTPS origin');
  const host = e.MC_HOST || 'titan.skydrive.metalabs.work';
  if (!/^[a-zA-Z0-9.-]+$/.test(host) || host.length > 240) throw new ConfigError('Invalid MC_HOST');
  const authMode = e.MCSKILL_AUTH_MODE || 'modern';
  if (!['modern', 'legacy'].includes(authMode)) throw new ConfigError('Invalid auth mode');
  const forgeProfile = e.FORGE_PROFILE || 'mcskill';
  if (!['mcskill', 'standard'].includes(forgeProfile)) throw new ConfigError('Invalid Forge profile');
  const reconnectMode = e.MC_RECONNECT_MODE || 'fixed';
  if (!['fixed', 'backoff'].includes(reconnectMode)) throw new ConfigError('Invalid reconnect mode');
  return {
    host, port: number(e, 'MC_PORT', 25565, 1, 65535), authOrigin, authMode, forgeProfile,
    sessionFile: e.MC_SESSION_FILE || 'session.json', modsFile: e.MC_MODS_FILE || new URL('../profiles/industrial-1.7.10.json', import.meta.url),
    timeout: number(e, 'MC_TIMEOUT_MS', 30000, 1000, 300000),
    idleTimeout: number(e, 'MC_IDLE_TIMEOUT_MS', 90000, 1000, 600000),
    testDuration: number(e, 'MC_TEST_DURATION_MS', 30000, 1000, 3600000),
    reconnectMode,
    reconnectInterval: number(e, 'MC_RECONNECT_INTERVAL_MS', 60000, 1000, 86400000),
    reconnectBase: number(e, 'MC_RECONNECT_BASE_MS', 15000, 1000, 3600000),
    reconnectMax: number(e, 'MC_RECONNECT_MAX_MS', 300000, 1000, 86400000),
    maxAttempts: number(e, 'MC_MAX_RETRIES', -1, -1, 10000),
    stableMs: number(e, 'MC_STABLE_MS', 300000, 1000, 86400000),
    maxPacket: number(e, 'MC_MAX_PACKET_BYTES', 4194304, 32768, 16777216)
  };
}
export async function sessionProvider(c, e = process.env) {
  let s;
  if (e.MC_ACCESS_TOKEN) s = { username: e.MC_USERNAME, uuid: e.MC_UUID, accessToken: e.MC_ACCESS_TOKEN };
  else {
    const info = await stat(c.sessionFile).catch(() => { throw new ConfigError('Session file unavailable; import an official launcher session'); });
    if (process.platform !== 'win32' && (info.mode & 0o077)) throw new ConfigError('Session file requires permissions 0600');
    if (info.size > 16384) throw new ConfigError('Session file too large');
    try { s = JSON.parse(await readFile(c.sessionFile, 'utf8')); } catch { throw new ConfigError('Invalid session JSON'); }
  }
  if (!/^[A-Za-z0-9_]{1,16}$/.test(s.username || '') || !/^[a-fA-F0-9]{32}$/.test((s.uuid || '').replaceAll('-', '')) || typeof s.accessToken !== 'string' || !s.accessToken || s.accessToken.length > 8192) throw new ConfigError('Invalid session fields');
  return { username: s.username, uuid: s.uuid.replaceAll('-', '').toLowerCase(), accessToken: s.accessToken };
}
export async function modProvider(c) {
  const a = JSON.parse(await readFile(c.modsFile, 'utf8'));
  if (!Array.isArray(a) || a.length > 1024) throw new ConfigError('Invalid mod manifest');
  const seen = new Set();
  for (const m of a) {
    if (!m.modid || !m.version || typeof m.modid !== 'string' || typeof m.version !== 'string' || m.modid.length > 256 || m.version.length > 256 || seen.has(m.modid)) throw new ConfigError('Invalid mod entry');
    seen.add(m.modid);
  }
  return a;
}
