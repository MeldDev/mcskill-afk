export class ProtocolError extends Error {
  constructor(message) { super(message); this.code = 'PROTOCOL'; this.retryable = false; }
}
export function varint(value) {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new ProtocolError('VarInt range');
  let n = value >>> 0; const bytes = [];
  do { let b = n & 127; n >>>= 7; if (n) b |= 128; bytes.push(b); } while (n);
  return Buffer.from(bytes);
}
export function readVarint(b, offset = 0, maxBytes = 5) {
  let n = 0;
  for (let i = 0; i < maxBytes; i++) {
    if (offset + i >= b.length) return null;
    const v = b[offset + i];
    if (i === 4 && (v & 0xf0)) throw new ProtocolError('VarInt overflow');
    n |= (v & 127) << (7 * i);
    if (!(v & 128)) return { value: n | 0, size: i + 1 };
  }
  throw new ProtocolError('VarInt too long');
}
export const concat = (...parts) => Buffer.concat(parts);
export function i16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; }
export function i32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }
export function string(s) { const b = Buffer.from(s); return concat(varint(b.length), b); }
export function shortBuffer(b) {
  if (b.length > 32767) throw new ProtocolError('Short array too large');
  return concat(i16(b.length), b);
}
export function packet(id, body = Buffer.alloc(0)) { const b = concat(varint(id), body); return concat(varint(b.length), b); }
export class Reader {
  constructor(b) { this.b = b; this.p = 0; }
  get remaining() { return this.b.length - this.p; }
  bytes(n) { if (n < 0 || n > this.remaining) throw new ProtocolError('Truncated packet'); const b = this.b.subarray(this.p, this.p + n); this.p += n; return b; }
  u8() { return this.bytes(1)[0]; }
  i8() { return this.bytes(1).readInt8(); }
  i16() { return this.bytes(2).readInt16BE(); }
  varShort(extended = false) {
    let low = this.bytes(2).readUInt16BE(), high = 0;
    if (low & 0x8000) { low &= 0x7fff; high = this.u8(); }
    const n = (high << 15) | low;
    return extended && n === 0x7fffff ? this.vi() : n;
  }
  i32() { return this.bytes(4).readInt32BE(); }
  f64() { return this.bytes(8).readDoubleBE(); }
  f32() { return this.bytes(4).readFloatBE(); }
  vi(max = 5) { const x = readVarint(this.b, this.p, max); if (!x) throw new ProtocolError('Truncated VarInt'); this.p += x.size; return x.value; }
  str(max = 32767, varBytes = 5) { const n = this.vi(varBytes); if (n < 0 || n > max * 4) throw new ProtocolError('String limit'); const s = this.bytes(n).toString('utf8'); if (s.length > max) throw new ProtocolError('String limit'); return s; }
  shortBytes() { return this.bytes(this.i16()); }
  end() { if (this.remaining) throw new ProtocolError('Unexpected trailing bytes'); }
}
// Fixed upper bound; copies each byte once even when a frame arrives byte by byte.
export class PacketCodec {
  constructor(max = 4 * 1024 * 1024) { this.max = max; this.header = []; this.body = null; this.used = 0; }
  progress() {
    let pendingPacketId=-1;
    if(this.body&&this.used){
      try { pendingPacketId=readVarint(this.body.subarray(0,this.used))?.value??-1; } catch {}
    }
    return {pendingFrameBytes:this.body?.length||0,pendingFrameReceived:this.used,
      pendingHeaderBytes:this.header.length,pendingPacketId};
  }
  feed(chunk, consume) {
    let p = 0;
    while (p < chunk.length) {
      if (!this.body) {
        this.header.push(chunk[p++]);
        const x = readVarint(Buffer.from(this.header));
        if (!x) continue;
        if (x.value < 1 || x.value > this.max) throw new ProtocolError('Frame size limit');
        this.body = Buffer.allocUnsafe(x.value); this.used = 0; this.header = [];
      }
      const n = Math.min(chunk.length - p, this.body.length - this.used);
      chunk.copy(this.body, this.used, p, p + n); this.used += n; p += n;
      if (this.used === this.body.length) {
        const frame = this.body; this.body = null; this.used = 0;
        consume(frame);
      }
    }
  }
}
