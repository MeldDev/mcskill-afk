import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { config, modProvider } from '../src/config.js';
import { passwordLogin } from '../src/launcher-auth.js';
import { MinecraftConnection } from '../src/connection.js';
import { reconnect } from '../src/reconnect.js';
import { Logger } from '../src/logger.js';
import { ConsoleController } from '../src/console.js';

const stop = new AbortController(), log = new Logger();
let consoleUI;
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
  LOGIN_INPUT_INVALID:'Логин или пароль не заполнены либо слишком длинные.'
};
try {
  const c = config(), mods = await modProvider(c);
  console.log('MCSkill AFK — вход отдельным аккаунтом.');
  console.log('Пароль скрыт при вводе и не сохраняется. Существующий session.json не используется.');
  const username = (await prompt('Логин второго аккаунта: ')).trim();
  let password = await prompt('Пароль: ', true), session;
  try { session = await passwordLogin(username, password, c.authOrigin, stop.signal); }
  finally { password = undefined; }
  console.log('Авторизация принята. Перед подключением закройте игру этого же аккаунта.');
  await prompt('Нажмите Enter для запуска AFK-бота (Ctrl+C — отмена): ');
  consoleUI=new ConsoleController({log,stop});
  // Session stays only in this process. No first-account file or environment token is loaded.
  process.exitCode = await reconnect(c, () => {
    const conn=new MinecraftConnection(c,session,mods,log);consoleUI.setConnection(conn);return conn.start('afk',stop.signal);
  }, log, stop.signal);
  if (process.exitCode) console.log('Бот остановлен из-за ошибки. При AUTH_REJECTED запустите файл заново для повторного входа.');
} catch (e) {
  if (stop.signal.aborted) { console.log('Остановлено.'); process.exitCode = 0; }
  else { console.error(messages[e.code] || 'Запуск не выполнен. Нужны Node.js 22.15+ и интерактивная консоль. Подробности: README.md.'); process.exitCode = 1; }
} finally { consoleUI?.close(); }
