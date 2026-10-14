import http2 from 'node:http2';
import { Reader, concat, varint } from './codec.js';

export class LauncherAuthError extends Error {
  constructor(code) { super(code); this.code = code; this.retryable = false; }
}
const fail = code => { throw new LauncherAuthError(code); };
const field = (id, value) => {
  const b = Buffer.from(value, 'utf8'); return concat(varint((id << 3) | 2), varint(b.length), b);
};
// Schema verified in the official Launcher.jar: launcher/auth.proto, common.proto.
export function encodeLogin(username, password) {
  if (typeof username !== 'string' || !username || username.length > 256 || typeof password !== 'string' || !password || password.length > 4096) fail('LOGIN_INPUT_INVALID');
  return concat(field(1, username), field(2, password));
}
function fields(buffer) {
  const r = new Reader(buffer), result = new Map(); let count = 0;
  while (r.remaining) {
    if (++count > 1024) fail('LOGIN_RESPONSE_INVALID');
    const tag = r.vi(), id = tag >>> 3, wire = tag & 7;
    if (!id) fail('LOGIN_RESPONSE_INVALID');
    if (wire === 2) {
      const value = r.bytes(r.vi());
      if (result.has(id)) fail('LOGIN_RESPONSE_INVALID');
      result.set(id, value);
    } else if (wire === 0) {
      let ended = false;
      for (let i = 0; i < 10; i++) if (!(r.u8() & 128)) { ended = true; break; }
      if (!ended) fail('LOGIN_RESPONSE_INVALID');
    } else if (wire === 1) r.bytes(8);
    else if (wire === 5) r.bytes(4);
    else fail('LOGIN_RESPONSE_INVALID');
  }
  return result;
}
export function decodeLogin(buffer) {
  try {
    const response = fields(buffer);
    if ([3,4,5].filter(id => response.has(id)).length !== 1) fail('LOGIN_RESPONSE_INVALID');
    if (response.has(4)) fail('LOGIN_MFA_REQUIRED');
    if (response.has(5)) fail('LOGIN_TOTP_REQUIRED');
    const session = fields(response.get(3));
    if (!session.has(1) || !session.has(2)) fail('LOGIN_RESPONSE_INVALID');
    const profile = fields(session.get(2));
    const accessToken = session.get(1).toString('utf8');
    const uuid = profile.get(1)?.toString('utf8').replaceAll('-', '').toLowerCase();
    const username = profile.get(2)?.toString('utf8');
    if (!/^[a-f0-9]{32}$/.test(uuid || '') || !/^[A-Za-z0-9_]{1,16}$/.test(username || '') || !accessToken || accessToken.length > 8192) fail('LOGIN_RESPONSE_INVALID');
    return { username, uuid, accessToken };
  } catch (e) { if (e instanceof LauncherAuthError) throw e; fail('LOGIN_RESPONSE_INVALID'); }
}
export function grpcFrame(payload) {
  const header = Buffer.alloc(5); header.writeUInt32BE(payload.length, 1); return concat(header, payload);
}
export function grpcMessage(buffer) {
  if (buffer.length < 5 || buffer[0] !== 0 || buffer.readUInt32BE(1) !== buffer.length - 5) fail('LOGIN_RESPONSE_INVALID');
  return buffer.subarray(5);
}
export function loginRpc(origin, payload, signal, connect = http2.connect) {
  if (!['https://launchernew.mcskill.ru', 'https://launchernew.mcskill.net'].includes(origin)) fail('LOGIN_ORIGIN_INVALID');
  if (signal?.aborted) return Promise.reject(new LauncherAuthError('LOGIN_CANCELLED'));
  return new Promise((resolve, reject) => {
    let client, stream, timer, settled = false; const chunks = []; let size = 0, status, httpStatus, contentType;
    const finish = (error, body) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      stream?.close(); client?.destroy();
      if (error) reject(error); else resolve(body);
    };
    const abort = () => finish(new LauncherAuthError('LOGIN_CANCELLED'));
    try {
      client = connect(origin); // TLS certificate/SNI verification remains enabled.
      client.on('error', () => finish(new LauncherAuthError('LOGIN_NETWORK')));
      client.on('close', () => { if (!settled) finish(new LauncherAuthError('LOGIN_NETWORK')); });
      stream = client.request({ ':method':'POST', ':path':'/launcher.AuthService/Login',
        'content-type':'application/grpc', 'te':'trailers', 'grpc-timeout':'20S',
        'x-user-agent':'mcskill-headless-afk/0.1.0', 'x-region':origin.endsWith('.ru') ? 'ru' : 'eu' });
      timer = setTimeout(() => finish(new LauncherAuthError('LOGIN_TIMEOUT')), 20000);
      signal?.addEventListener('abort', abort, { once:true });
      stream.on('response', h => { httpStatus = h[':status']; contentType = h['content-type']; status = h['grpc-status']; });
      stream.on('trailers', h => { status = h['grpc-status']; });
      stream.on('data', b => {
        size += b.length;
        if (size > 65536) finish(new LauncherAuthError('LOGIN_RESPONSE_INVALID')); else chunks.push(b);
      });
      stream.on('error', () => finish(new LauncherAuthError('LOGIN_NETWORK')));
      stream.on('aborted', () => finish(new LauncherAuthError('LOGIN_NETWORK')));
      stream.on('end', () => {
        if (httpStatus !== 200 || !String(contentType).startsWith('application/grpc')) return finish(new LauncherAuthError('LOGIN_NETWORK'));
        if (String(status) !== '0') return finish(new LauncherAuthError(['7','16'].includes(String(status)) ? 'LOGIN_REJECTED' : 'LOGIN_SERVICE_ERROR'));
        try { finish(null, grpcMessage(Buffer.concat(chunks))); } catch { finish(new LauncherAuthError('LOGIN_RESPONSE_INVALID')); }
      });
      // Password is in the TLS request body, never an argument, URL, header or log.
      stream.end(grpcFrame(payload));
    } catch { finish(new LauncherAuthError('LOGIN_NETWORK')); }
  });
}
export async function passwordLogin(username, password, authOrigin, signal, transport = loginRpc) {
  const origin = authOrigin === 'https://auth.mcskill.ru' ? 'https://launchernew.mcskill.ru'
    : authOrigin === 'https://auth.mcskill.net' ? 'https://launchernew.mcskill.net' : null;
  if (!origin) fail('LOGIN_ORIGIN_INVALID');
  const payload = encodeLogin(username, password);
  try { return decodeLogin(await transport(origin, payload, signal)); }
  finally { payload.fill(0); }
}
