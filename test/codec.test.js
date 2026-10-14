import { test } from 'node:test';
import assert from 'node:assert/strict';
import { varint, readVarint, Reader, PacketCodec, packet, string, i16, concat } from '../src/codec.js';
test('VarInt boundary values and signed roundtrip', () => {
  for (const n of [0,1,127,128,255,2147483647,-1,-2147483648]) assert.equal(readVarint(varint(n)).value, n);
  assert.equal(varint(-1).toString('hex'), 'ffffffff0f');
  assert.equal(readVarint(Buffer.from([128])), null);
  assert.throws(() => readVarint(Buffer.from('ffffffff7f','hex')));
  assert.throws(() => readVarint(Buffer.from('808080808000','hex')));
});
test('packet encoding, UTF8 string and partial TCP bytes', () => {
  const encoded = packet(63, string('Привет'));
  const frames = []; const codec = new PacketCodec();
  for (const b of encoded) codec.feed(Buffer.from([b]), b => frames.push(b));
  assert.equal(frames.length, 1); const r = new Reader(frames[0]); assert.equal(r.vi(), 63); assert.equal(r.str(), 'Привет'); r.end();
});
test('multiple frames in one chunk and arbitrary splits', () => {
  const wire = concat(...Array.from({length:100}, (_,i) => packet(i, Buffer.alloc(i))));
  for (const split of [1,2,3,17,257,wire.length]) {
    const codec = new PacketCodec(), frames = [];
    for (let p = 0; p < wire.length; p += split) codec.feed(wire.subarray(p,p+split), b => frames.push(b));
    assert.equal(frames.length, 100);
    frames.forEach((b,i) => { const r = new Reader(b); assert.equal(r.vi(), i); assert.equal(r.remaining,i); });
  }
});
test('bounded framing rejects oversized and empty frames before allocation', () => {
  for (const b of [varint(0), varint(-1), varint(1025)]) assert.throws(() => new PacketCodec(1024).feed(b, () => {}));
  const r = new Reader(concat(i16(5), Buffer.alloc(4))); assert.throws(() => r.shortBytes());
});
test('Forge VarShort and Hodgepodge extended sentinel', () => {
  assert.equal(new Reader(Buffer.from('0005','hex')).varShort(),5);
  assert.equal(new Reader(Buffer.from('800101','hex')).varShort(),32769);
  assert.equal(new Reader(concat(Buffer.from('ffffff','hex'),varint(9000000))).varShort(true),9000000);
  assert.throws(() => new Reader(Buffer.from('8001','hex')).varShort());
});
