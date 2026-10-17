import { config, sessionProvider, modProvider } from './config.js';
import { MinecraftConnection } from './connection.js';
import { reconnect } from './reconnect.js';
import { Logger } from './logger.js';
import { ConsoleController } from './console.js';
import { ControlServer } from './control-server.js';
const mode = process.argv[2] || 'afk';
const log = new Logger(), stop = new AbortController();
let consoleUI, control;
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => { log.event('shutdown'); stop.abort(); });
try {
  if (!['probe','auth-test','forge-test','afk'].includes(mode)) throw new Error('Invalid mode');
  const c = config();
  const mods = mode === 'probe' || mode === 'auth-test' ? [] : await modProvider(c);
  if(mode==='afk'){
    consoleUI=new ConsoleController({log,stop});
    if(process.env.MC_CONTROL_SOCKET)control=await new ControlServer({path:process.env.MC_CONTROL_SOCKET,log,stop}).start();
  }
  const connect = async () => {
    // Reload credentials on every reconnect so atomic replacement takes effect.
    const session = mode === 'probe' ? { username: 'HeadlessProbe' } : await sessionProvider(c);
    const conn = new MinecraftConnection(c, session, mods, log);
    consoleUI?.setConnection(conn);
    control?.setConnection(conn);
    return conn.start(mode, stop.signal);
  };
  if (mode === 'afk') process.exitCode = await reconnect(c, connect, log, stop.signal);
  else {
    const result = await connect();
    log.event('test_result', { state: result.reached ? 'PASSED' : 'FAILED', code: result.error?.code || 'OK', packets: result.packets, keepAlives: result.keepAlives });
    process.exitCode = result.reached || stop.signal.aborted ? 0 : 1;
  }
} catch (e) {
  log.event('fatal', { code: e.code || 'CONFIG_OR_INTERNAL' }); process.exitCode = 1;
} finally { await control?.close();consoleUI?.close(); }
