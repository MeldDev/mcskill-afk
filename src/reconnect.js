import { setTimeout as sleep } from 'node:timers/promises';
export function backoff(attempt, base, max, random = Math.random) {
  return Math.min(max, Math.round(base * 2 ** Math.min(attempt - 1, 30) * (0.8 + random() * 0.4)));
}
export async function reconnect(c, connect, log, signal, wait = (ms, signal) => sleep(ms, undefined, { signal })) {
  let failures = 0;
  while (!signal.aborted) {
    let result;
    try { result = await connect(); }
    catch (error) {
      // Network/setup exceptions must use the same retry loop as socket errors.
      // Explicit local configuration/credential failures can still stop it.
      result = { error: { code: error?.code || 'INTERNAL', retryable: error?.retryable !== false } };
    }
    if (signal.aborted || result.error?.code === 'STOPPED') return 0;
    if (!result.error) return 0;
    log.event('connection_closed', { code: result.error.code || 'INTERNAL' });
    if (result.error.retryable !== true) return 1;
    if (result.stableMs >= c.stableMs) failures = 0;
    failures = Math.min(failures + 1, Number.MAX_SAFE_INTEGER);
    if (c.maxAttempts !== -1 && failures > c.maxAttempts) { log.event('retry_limit'); return 1; }
    const unavailable = result.serverUnavailable === true;
    const delayMs = unavailable ? (c.unavailableInterval ?? 300000) :
      c.reconnectMode === 'fixed' ? c.reconnectInterval : backoff(failures, c.reconnectBase, c.reconnectMax);
    log.event('reconnecting', { attempt: failures, delayMs });
    try { await wait(delayMs, signal); } catch { return signal.aborted ? 0 : 1; }
  }
  return 0;
}
