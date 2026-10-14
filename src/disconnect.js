// Classify only recognized downtime messages. Never log the server-provided text.
export function disconnectCode(raw) {
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
  if (/banned|banhammer|забан|afk|афк|invalid.session|session.*(?:expired|invalid)|недействительн.*сесси|авторизац|authenticat|captcha|капч|whitelist|бел.{0,10}спис|already (?:logged|connected)|duplicate login|уже.{0,15}(?:игре|сервере)/i.test(text)) return 'SERVER_DISCONNECT';
  if (/restart|shutting down|server (?:is )?closed|server_shutdown|перезагру[зж]|перезапуск|рестарт|техническ.{0,20}работ|maintenance/i.test(text)) return 'SERVER_RESTART';
  if (/server (?:is )?full|сервер.{0,10}заполнен|server (?:is )?(?:offline|unavailable)|сервер.{0,15}недоступен|could not connect to.{0,30}server|не удалось подключиться к серверу/i.test(text)) return 'SERVER_UNAVAILABLE';
  return 'SERVER_DISCONNECT';
}
