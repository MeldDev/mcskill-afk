import { stripVTControlCharacters } from 'node:util';
export function safeConsoleText(text, max = 8192) {
  return stripVTControlCharacters(String(text)).replace(/\r\n|[\r\n]/g, ' ↵ ')
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/§[0-9a-fk-or]/gi, '').slice(0, max);
}
const translations = { 'chat.type.text':'<%s> %s', 'chat.type.announcement':'[%s] %s', 'chat.type.emote':'* %s %s' };
export function formatChat(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return safeConsoleText(raw); }
  let budget = 2048;
  function render(node, depth = 0) {
    if (--budget < 0 || depth > 16 || node == null) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node).slice(0,8192);
    if (Array.isArray(node)) return node.slice(0,256).map(x => render(x,depth+1)).join('').slice(0,8192);
    if (typeof node !== 'object') return '';
    let text = typeof node.text === 'string' ? node.text.slice(0,8192) : '';
    if (typeof node.translate === 'string') {
      const args = Array.isArray(node.with) ? node.with.slice(0,32).map(x => render(x,depth+1)) : [];
      const template = translations[node.translate]; let i = 0;
      text += template ? template.replace(/%(?:(\d+)\$)?s|%%/g,(m,n) => m === '%%' ? '%' : args[n ? Number(n)-1 : i++] || '')
        : `${node.translate.slice(0,256)}${args.length ? ': '+args.join(' ') : ''}`;
    }
    if (Array.isArray(node.extra)) text += render(node.extra,depth+1);
    return text.slice(0,8192);
  }
  return safeConsoleText(render(value));
}
export function validateChat(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 100 || /[\x00-\x1f\x7f§]/.test(text)) throw new Error('CHAT_INVALID');
  return text;
}
