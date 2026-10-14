import { Reader, ProtocolError, concat, varint, string, i32 } from './codec.js';
// FML 7 / protocol 5: discriminator 3 is ModIdData, NOT 1.8 RegistryData.
export class ForgeHandshakeHandler {
  constructor({ send, mods, profile = 'mcskill', log, complete, resetting = () => {} }) {
    Object.assign(this, { send, mods, profile, log, complete, resetting }); this.reset();
  }
  reset() { this.state = 'HELLO'; this.done = false; }
  ack(n) { this.send('FML|HS', Buffer.from([255, n])); }
  handle(data) {
    const r = new Reader(data); const type = r.u8();
    if (type === 254) {
      r.end(); if (!this.done) throw new ProtocolError('Unexpected FML reset');
      this.reset(); this.resetting(); this.log.event('forge_reset'); return;
    }
    if (this.state === 'HELLO' && type === 0) {
      const version = r.u8(); if (version !== 1 && version !== 2) throw new ProtocolError('Unsupported FML protocol');
      if (version > 1) this.dimension = r.i32(); r.end();
      this.send('REGISTER', Buffer.from('FML|HS\0FML'));
      // Locally verified MetaHandshakePatcher: int snapshot hash precedes FML version.
      // Zero means no cached registry; always request the full authoritative mapping.
      this.send('FML|HS', concat(Buffer.from([1]), this.profile === 'mcskill' ? i32(0) : Buffer.alloc(0), Buffer.from([2])));
      this.send('FML|HS', concat(Buffer.from([2]), varint(this.mods.length), ...this.mods.flatMap(m => [string(m.modid), string(m.version)])));
      this.state = 'MODLIST';
    } else if (this.state === 'MODLIST' && type === 2) {
      const count = r.vi(2); if (count < 0 || count > 4096) throw new ProtocolError('Mod count limit');
      // Server-only mods are legitimate. Do not echo server versions as client mods.
      for (let i = 0; i < count; i++) { r.str(256, 2); r.str(256, 2); }
      r.end(); this.log.event('forge_server_mods', { mods: count }); this.ack(2); this.state = 'REGISTRY';
    } else if (this.state === 'REGISTRY' && type === 3) {
      const count = r.vi(3); if (count < 0 || count > 131072) throw new ProtocolError('Registry count limit');
      // No block/item lookup or rendering is performed, so validate then discard.
      for (let i = 0; i < count; i++) { r.str(32767, 2); r.vi(3); }
      if (r.remaining) {
        for (let kind = 0; kind < 2; kind++) {
          const n = r.vi(3); if (n < 0 || n > 131072) throw new ProtocolError('Substitution count limit');
          for (let i = 0; i < n; i++) r.str(32767, 2);
        }
      }
      r.end(); this.log.event('forge_registry', { mappings: count }); this.ack(3); this.state = 'ACK2';
    } else if (this.state === 'ACK2' && type === 255 && r.u8() === 2) {
      r.end(); this.ack(4); this.state = 'ACK3';
    } else if (this.state === 'ACK3' && type === 255 && r.u8() === 3) {
      r.end(); this.ack(5); this.state = 'DONE'; this.done = true; this.complete();
    } else throw new ProtocolError('Unexpected FML handshake message');
    this.log.event('forge_state', { state: this.state });
  }
}
