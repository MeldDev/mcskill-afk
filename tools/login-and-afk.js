import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { config, modProvider } from '../src/config.js';
import { passwordLogin } from '../src/launcher-auth.js';
import { MinecraftConnection } from '../src/connection.js';
import { reconnect } from '../src/reconnect.js';
import { Logger } from '../src/logger.js';
import { ConsoleController } from '../src/console.js';
import { credentialsPath, acquireAccount } from '../src/credentials.js';
import { passwordConnector } from '../src/password-connection.js';
import { ControlServer } from '../src/control-server.js';

const stop = new AbortController(), log = new Logger();
let consoleUI, control;
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => stop.abort());
async function prompt(label, hidden = false) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('INTERACTIVE_CONSOLE_REQUIRED');
  const output = hidden ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : process.stdout;
  const rl = createInterface({ input:process.stdin, output, terminal:true, historySize:0 });
  const cancel = () => { stop.abort(); rl.close(); };
  rl.once('SIGINT', cancel);
  try {
    if (hidden) process.stdout.write(label);
    return await rl.question(hidden ? '' : label, { signal:stop.signal });
  } finally { rl.close(); if (hidden) { output.destroy(); process.stdout.write('\n'); } }
}
const messages = {
  LOGIN_REJECTED:'Вход отклонён. Проверьте логин и пароль в официальном лаунчере.',
  LOGIN_MFA_REQUIRED:'Сервер требует дополнительное подтверждение. Подтвердите вход в официальном лаунчере; проверка не обходится.',
  LOGIN_TOTP_REQUIRED:'Сервер требует код двухфакторной защиты. Выполните вход через официальный лаунчер.',
  LOGIN_NETWORK:'Не удалось связаться со штатным API лаунчера. Проверьте сеть и выбранный регион.',
  LOGIN_TIMEOUT:'API лаунчера не ответил вовремя.',
  LOGIN_SERVICE_ERROR:'API лаунчера отклонил запрос. Войдите через официальный лаунчер для диагностики.',
  LOGIN_RESPONSE_INVALID:'Ответ API лаунчера не соответствует проверенному формату.',
  LOGIN_INPUT_INVALID:'Логин или пароль не заполнены либо слишком длинные.',
  CREDENTIALS_MISSING:'Нет сохранённых данных. Выполните ./start.sh --setup и ответьте Y.',
  CREDENTIALS_INVALID:'Файл данных повреждён или имеет небезопасные права. Выполните ./start.sh --setup.',
  CREDENTIALS_SAVE_FAILED:'Не удалось сохранить приватный файл данных. Проверьте права доступа.'
};
try {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--setup','--service','--forget'].includes(arg)) || args.length > 1) throw new Error('INVALID_ARGUMENT');
  const service = args.includes('--service'), setup = args.includes('--setup');
  if (args.includes('--forget')) {
    const { unlink } = await import('node:fs/promises');
    await unlink(credentialsPath()).catch(e => { if (e.code !== 'ENOENT') throw e; });
    console.log('Сохранённые данные удалены.');
  } else {
    const c = config(), mods = await modProvider(c);
    console.log('MCSkill AFK — вход своим аккаунтом. Пароль скрыт при вводе.');
    const { credentials, initialSession, saved } = await acquireAccount({ authOrigin:c.authOrigin, prompt,
      login:passwordLogin, signal:stop.signal, setup, service });
    if (saved) console.log('Данные сохранены вне репозитория. Пароль хранится в открытом виде с ограниченным доступом к файлу.');
    if (setup) console.log('Настройка завершена. Можно запускать сервис.');
    else {
      c.authOrigin = credentials.authOrigin;
      console.log('Запуск AFK. Этот аккаунт должен быть закрыт в другом клиенте.');
      consoleUI = new ConsoleController({log,stop});
      if(process.env.MC_CONTROL_SOCKET)control=await new ControlServer({path:process.env.MC_CONTROL_SOCKET,log,stop}).start();
      let terminal = false;
      const connect = passwordConnector({ credentials, initialSession, login:passwordLogin, signal:stop.signal, log,
        connect:async session => {
          const conn = new MinecraftConnection(c,session,mods,log);
          consoleUI.setConnection(conn); control?.setConnection(conn); return conn.start('afk',stop.signal);
        } });
      process.exitCode = await reconnect(c, async () => {
        const result = await connect();
        terminal = !!result.error && result.error.retryable !== true && result.error.code !== 'STOPPED';
        return result;
      }, log, stop.signal);
      if (process.exitCode && terminal) process.exitCode = 78;
      if (process.exitCode) consoleUI.writeLine('Бот остановлен. Причина в connection_closed. Для замены данных: ./start.sh --setup; затем перезапустите сервис.');
    }
  }
} catch (e) {
  if (stop.signal.aborted) { console.log('Остановлено.'); process.exitCode = 0; }
  else {
    log.event('startup_failed', {code:e.code || 'INTERNAL'});
    console.error(messages[e.code] || 'Запуск не выполнен. Подробности: README.md.');
    process.exitCode = e.code === 'CONFIG' || e.code?.startsWith('CREDENTIALS_') ||
      (e.code?.startsWith('LOGIN_') && !['LOGIN_NETWORK','LOGIN_TIMEOUT','LOGIN_SERVICE_ERROR'].includes(e.code)) ? 78 : 1;
  }
} finally { await control?.close();consoleUI?.close(); }
