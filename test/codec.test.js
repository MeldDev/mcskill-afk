import { test } from 'node:test';
import assert from 'node:assert/strict';
import { varint, readVarint, Reader, PacketCodec, packet, string, i16, concat } from '../src/codec.js';
import { aes } from '../src/encryption.js';
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

test('decoder progress exposes only scalar lengths and ID, including split headers',()=>{
 const codec=new PacketCodec();
 codec.feed(Buffer.from([0x90]),()=>assert.fail('incomplete header'));
 assert.deepEqual(codec.progress(),{pendingFrameBytes:0,pendingFrameReceived:0,pendingHeaderBytes:1,pendingPacketId:-1});
 codec.feed(concat(Buffer.from([0x4e,0x21]),Buffer.from('FAKE_PRIVATE_DATA')),()=>assert.fail('incomplete body'));
 const progress=codec.progress();assert.equal(progress.pendingFrameBytes,10000);assert.equal(progress.pendingPacketId,0x21);
 assert.equal(progress.pendingFrameReceived,18);assert.ok(!JSON.stringify(progress).includes('FAKE_PRIVATE_DATA'));
});

test('thousands of AES frames keep alignment across randomized encryption and TCP boundaries',()=>{
 let seed=1234567;
 const random=max=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max};
 const bodies=Array.from({length:4096},(_,i)=>concat(varint(i%65),Buffer.alloc(i%511===0?131072:random(1024),i&255)));
 const wire=concat(...bodies.map(body=>concat(varint(body.length),body)));
 const secret=Buffer.alloc(16,7),sender=aes(secret),receiver=aes(secret),encrypted=[];
 for(let p=0;p<wire.length;){const n=Math.min(wire.length-p,1+random(8192));encrypted.push(sender.encrypt.update(wire.subarray(p,p+n)));p+=n;}
 const network=concat(...encrypted),codec=new PacketCodec();let index=0;
 for(let p=0;p<network.length;){const n=Math.min(network.length-p,1+random(2048));codec.feed(receiver.decrypt.update(network.subarray(p,p+n)),frame=>assert.deepEqual(frame,bodies[index++]));p+=n;}
 assert.equal(index,bodies.length);assert.deepEqual(codec.progress(),{pendingFrameBytes:0,pendingFrameReceived:0,pendingHeaderBytes:0,pendingPacketId:-1});
});
