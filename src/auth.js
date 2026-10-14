import https from 'node:https';
export class AuthError extends Error {
  constructor(code, retryable = false) { super(code === 'AUTH_REJECTED' ? 'MCSkill rejected session; sign in manually in the official launcher and replace the session file' : 'MCSkill authentication unavailable'); this.code = code; this.retryable = retryable; }
}
export class McSkillSessionService {
  constructor(c, request = https.request) { this.c = c; this.request = request; }
  async join(session, hash, signal) {
    const path = this.c.authMode === 'legacy' ? '/joinserver1710.php' : '/join1710';
    const url = new URL(this.c.authOrigin + path);
    if (!['auth.mcskill.ru', 'auth.mcskill.net'].includes(url.hostname) || url.protocol !== 'https:' || url.port) throw new AuthError('AUTH_REJECTED');
    const body = JSON.stringify({ accessToken: session.accessToken, selectedProfile: session.uuid, serverId: hash });
    return new Promise((resolve, reject) => {
      const req = this.request(url, { method: 'POST', signal, timeout: 15000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
        const chunks = []; let size = 0;
        res.on('data', b => { size += b.length; if (size > 16384) res.destroy(new AuthError('AUTH_UNAVAILABLE', true)); else chunks.push(b); });
        res.on('error', () => reject(new AuthError('AUTH_UNAVAILABLE', true)));
        res.on('end', () => {
          // Never log response bodies: these may contain credentials or identifying data.
          if (res.statusCode >= 500 || res.statusCode === 429) return reject(new AuthError('AUTH_UNAVAILABLE', true));
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new AuthError('AUTH_REJECTED'));
          const text = Buffer.concat(chunks).toString('utf8');
          if (text.trim()) {
            try { const result = JSON.parse(text); if (!result || typeof result !== 'object' || result.error) return reject(new AuthError('AUTH_REJECTED')); }
            catch { return reject(new AuthError('AUTH_UNAVAILABLE', true)); }
          }
          resolve();
        });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => reject(new AuthError('AUTH_UNAVAILABLE', true)));
      req.end(body);
    });
  }
}
