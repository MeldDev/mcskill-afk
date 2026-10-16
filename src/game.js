import { Reader, ProtocolError, concat, string } from './codec.js';
import { formatChat } from './chat.js';
import { InventoryHandler } from './inventory.js';
export class GameSessionHandler {
  constructor({ send, plugin, forge, log, joined, positioned, chat = () => {}, inventoryStatus = () => {} }) {
    Object.assign(this, { send, plugin, forge, log, joined, positioned });
    this.keepAlives = 0; this.channelCount = 0; this.unknownPayloads = 0;
    this.chat = chat;
    this.inventory = new InventoryHandler({send,profile:forge.profile,status:inventoryStatus});
  }
  handle(id, body) {
    const r = new Reader(body);
    switch (id) {
      case 0x00:
        r.i32(); r.end(); this.send(0, body); this.keepAlives++; return;
      case 0x02:
        { const text=r.str();r.end();this.chat(formatChat(text));return; }
      case 0x01: {
        r.i32(); r.u8(); let dimension = r.i8(); const difficulty = r.u8(); r.u8(); r.str(16);
        // MetaLib appends a full-width dimension after the vanilla fields.
        if (this.forge.profile === 'mcskill') dimension = r.i32();
        r.end();
        this.send(0x15, concat(string('en_US'), Buffer.from([2, 0, 1, difficulty, 0])));
        this.plugin('MC|Brand', Buffer.from('headless-afk', 'utf8'));
        this.joined(); this.log.event('join_game', { dimension }); return;
      }
      case 0x07:
        r.i32(); r.u8(); r.u8(); r.str(16); r.end(); this.position = null; this.inventory.invalidate(); return;
      case 0x2d: case 0x2e: case 0x2f: case 0x30:
        this.inventory.handle(id,body);return;
      case 0x08: {
        const x = r.f64(), y = r.f64(), z = r.f64(), yaw = r.f32(), pitch = r.f32();
        const onGround = r.u8(); r.end();
        if (onGround > 1) throw new ProtocolError('Invalid ground flag');
        if (![x, y, z, yaw, pitch].every(Number.isFinite) || Math.abs(x) > 32000000 || Math.abs(z) > 32000000 || Math.abs(y) > 1000000) throw new ProtocolError('Invalid position');
        // S08 in 1.7.10 carries eye Y. C06 wire order is feet Y, stance Y.
        this.position = { x, y: y - 1.62, z, yaw, pitch, onGround };
        this.sendPosition(); this.positioned(); return;
      }
      case 0x32: {
        this.inventory.handle(id,body);
        r.u8(); r.i16(); const accepted = r.u8(); r.end();
        if (!accepted) this.send(0x0f, concat(body.subarray(0, 3), Buffer.from([1]))); return;
      }
      case 0x3f: {
        let channel;
        try { channel = r.str(20); }
        catch (error) { if (error instanceof ProtocolError) error.message = `Plugin channel: ${error.message}`; throw error; }
        if (!['FML|HS','REGISTER','UNREGISTER'].includes(channel)) {
          // The outer Minecraft frame is already bounded and fully consumed.
          // Opaque mod messages can use patched length formats. Never interpret
          // their envelope or content when we do not implement that channel.
          this.unknownPayloads++;
          if (this.unknownPayloads === 1) this.log.event('unhandled_mod_payload', { bytes:r.remaining });
          return;
        }
        const payload = r.bytes(r.varShort(this.forge.profile === 'mcskill')); r.end();
        if (channel === 'FML|HS') this.forge.handle(payload);
        else if (channel === 'REGISTER' || channel === 'UNREGISTER') {
          // Count only: no unbounded set of server-provided channel names.
          if (payload.length > 32767) throw new ProtocolError('Channel registration limit');
          this.channelCount = payload.toString('utf8').split('\0').length;
          this.log.event('plugin_channels', { channels: this.channelCount });
        }
        return;
      }
      default:
        if (id > 0x40) throw new ProtocolError('Unknown protocol 5 packet ID');
        // Chunks and entities are never decoded or retained.
    }
  }
  sendPosition() {
    if (!this.position) return;
    const { x, y, z, yaw, pitch, onGround } = this.position;
    const b = Buffer.alloc(41);
    b.writeDoubleBE(x, 0); b.writeDoubleBE(y, 8); b.writeDoubleBE(y + 1.62, 16); b.writeDoubleBE(z, 24);
    b.writeFloatBE(yaw, 32); b.writeFloatBE(pitch, 36); b[40] = onGround;
    this.send(0x06, b);
  }
  tick() {
    if (!this.position || !this.forge.done) return;
    this.inventory.tick();
    // Vanilla cadence: one unchanged position per second, ground state at 20 Hz.
    // No autonomous movement or AFK evasion; ground state remains server-provided.
    this.ticks = (this.ticks || 0) + 1;
    if (this.ticks % 20 === 0) this.sendPosition(); else this.send(0x03, Buffer.from([this.position.onGround]));
  }
}
