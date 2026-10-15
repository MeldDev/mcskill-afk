// Proxies may use generic login refusals while the backend is starting.
// Unknown PLAY kicks remain terminal; LOGIN refusals retry unless clearly permanent.
// Never log the server-provided text.
export function disconnectCode(raw, state = 'PLAY') {
  let component;
  try { component = JSON.parse(raw); } catch { component = raw; }
  const parts = [], queue = [[component, 0]];
  for (let i = 0; i < queue.length && i < 1024; i++) {
    const [value, depth] = queue[i];
    if (typeof value === 'string') parts.push(value);
    else if (value && depth < 8) {
      const children = Array.isArray(value) ? value : [value.text, value.translate, value.extra, value.with];
      for (const child of children) { if (queue.length >= 1024) break; queue.push([child, depth + 1]); }
    }
  }
  const text = parts.join(' ').replace(/\u00a7[0-9a-fk-or]/gi, '');
  // Even a message mentioning restart must not restart an AFK kick or auth/ban rejection.
  if (/banned|banhammer|забан|в бане|вы.{0,15}заблокирован|afk|афк|idling|idle.?timeout|слишком долго бездейств|неактивност|(?:invalid|incorrect|wrong|bad).{0,15}(?:password|credentials)|неверн.{0,15}(?:парол|логин)|two.?factor|2fa|mfa|totp|подтвержд.{0,30}(?:вход|устройств)|нов.{0,15}устройств|captcha|капч|whitelist|бел.{0,10}спис|already (?:logged|connected)|duplicate login|уже.{0,15}(?:игре|сервере)|invalid host(?:name)?|outdated (?:client|server)|incompatible (?:client|version)|несовместим|устаревш/i.test(text)) return 'SERVER_DISCONNECT';
  if (/invalid[\s._-]*session|expired[\s._-]*session|session.*(?:expired|invalid)|недействительн.*сесси|сесси.{0,20}(?:истек|истёк)/i.test(text)) return 'SERVER_SESSION_EXPIRED';
  // Auth API downtime is different from invalid account credentials.
  if (/auth(?:entication)?.{0,20}servers?.{0,20}(?:down|unavailable)|authservers_down|авторизац.{0,40}(?:недоступ|позже)|(?:temporar|временн).{0,40}(?:auth|авторизац)/i.test(text)) return 'SERVER_UNAVAILABLE';
  if (/failed to verify (?:user ?name|username)|авторизац|authenticat/i.test(text)) return 'SERVER_DISCONNECT';
  if (/restart|shutting down|server (?:is )?closed|server_shutdown|перезагру[зж]|перезапуск|рестарт|техническ.{0,20}работ|maintenance/i.test(text)) return 'SERVER_RESTART';
  if (/server (?:is )?full|сервер.{0,10}заполнен|server (?:is )?(?:offline|unavailable)|сервер.{0,15}недоступен|could not connect to.{0,30}server|не удалось подключиться к серверу/i.test(text)) return 'SERVER_UNAVAILABLE';
  return state === 'LOGIN' ? 'SERVER_LOGIN_RETRY' : 'SERVER_DISCONNECT';
}
