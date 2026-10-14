// Explicit integration check: uses the configured official session, never test tokens.
// One deliberate local TCP drop; at most two retries. No firewall or server action.
import assert from 'node:assert/strict';
import { config, sessionProvider, modProvider } from '../src/config.js';
import { MinecraftConnection } from '../src/connection.js';
import { reconnect } from '../src/reconnect.js';
import { Logger } from '../src/logger.js';
const log = new Logger(), stop = new AbortController();
for (const s of ['SIGINT','SIGTERM']) process.once(s, () => stop.abort());
let connections = 0, ready = 0, timer, success = false;
const cpu = process.cpuUsage(), started = Date.now();
try {
  const c = config(); c.maxAttempts = 2;
  const mods = await modProvider(c);
  const code = await reconnect(c, async () => {
    connections++;
    const conn = new MinecraftConnection(c, await sessionProvider(c), mods, log);
    conn.once('ready', () => {
      ready++;
      timer = setTimeout(() => {
        if (!conn.game.keepAlives) { conn.close(); return; }
        if (ready === 1) { log.event('test_tcp_drop'); conn.socket.destroy(); }
        else { success = true; stop.abort(); }
      }, ready === 1 ? 15000 : 60000);
    });
    const result = await conn.start('afk', stop.signal); clearTimeout(timer); return result;
  }, log, stop.signal);
  assert.equal(code, 0); assert.ok(success); assert.equal(ready, 2); assert.equal(connections, 2);
  const usage = process.cpuUsage(cpu), m = process.memoryUsage();
  log.event('live_reconnect_passed', { count: ready, durationMs: Date.now() - started, rssMiB: Math.round(m.rss / 1048576) });
  // CPU count in milliseconds, not percent; compare against elapsed wall time.
  log.event('live_cpu_milliseconds', { count: Math.round((usage.user + usage.system) / 1000) });
} catch {
  clearTimeout(timer); stop.abort(); log.event('live_reconnect_failed'); process.exitCode = 1;
}
