import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForgeHandshakeHandler } from '../src/forge.js';
import { GameSessionHandler } from '../src/game.js';
import { Reader, PacketCodec, packet, concat, varint, string, i16, i32 } from '../src/codec.js';
const log={event(){}};
test('exact 1.7.10 MetaHandshakePatcher hello, registry, ack states and reset', () => {
  const sent=[];let complete=0;
  const f=new ForgeHandshakeHandler({send:(...a)=>sent.push(a),mods:[{modid:'FML',version:'7.99.40.1614'}],log,complete:()=>complete++});
  f.handle(concat(Buffer.from([0,2]),i32(0)));
  assert.equal(sent[1][1].toString('hex'),'010000000002');
  f.handle(Buffer.from([2,0])); assert.equal(sent.at(-1)[1].toString('hex'),'ff02');
  f.handle(concat(Buffer.from([3]),varint(1),string('minecraft:stone'),varint(1),varint(0),varint(0)));
  assert.equal(sent.at(-1)[1].toString('hex'),'ff03');
  f.handle(Buffer.from([255,2])); f.handle(Buffer.from([255,3]));
  assert.equal(complete,1); assert.ok(f.done); f.handle(Buffer.from([254])); assert.equal(f.state,'HELLO');
  assert.throws(()=>f.handle(Buffer.from([3,0])));
});
test('Forge 1.7 ModIdData has no hasMore boolean; empty map is valid', () => {
  const f=new ForgeHandshakeHandler({send(){},mods:[],profile:'standard',log,complete(){}});
  f.handle(Buffer.from([0,1]));f.handle(Buffer.from([2,0]));f.handle(Buffer.from([3,0,0,0]));assert.equal(f.state,'ACK2');
});
test('KeepAlive uses i32; teleport ack uses feet/stance and no 1.9 confirm packet', () => {
  const sent=[];const g=new GameSessionHandler({send:(...a)=>sent.push(a),plugin(){},forge:{done:true},log,joined(){},positioned(){}});
  g.handle(0,i32(123456));assert.deepEqual(sent.pop(),[0,i32(123456)]);
  const p=Buffer.alloc(33);p.writeDoubleBE(1,0);p.writeDoubleBE(65.62,8);p.writeDoubleBE(2,16);p.writeFloatBE(90,24);p[32]=1;
  g.handle(8,p);const [id,ack]=sent.pop();assert.equal(id,6);assert.equal(ack.length,41);assert.ok(Math.abs(ack.readDoubleBE(8)-64)<1e-9);assert.equal(ack.readDoubleBE(16),65.62);assert.equal(ack[40],1);
  for(let i=0;i<20;i++)g.tick();assert.equal(sent.length,20);assert.equal(sent.at(-1)[0],6);
});
test('Join Game settings, rejected transaction confirmation and chunk discard', () => {
  const sent=[];let joined=0;
  const g=new GameSessionHandler({send:(...a)=>sent.push(a),plugin(){},forge:{},log,joined(){joined++},positioned(){}});
  g.handle(1,concat(i32(1),Buffer.from([0,0,2,10]),string('default')));assert.equal(joined,1);assert.equal(sent[0][0],0x15);
  g.handle(0x32,concat(Buffer.from([0]),i16(1),Buffer.from([0])));assert.equal(sent.at(-1)[0],15);
  g.handle(0x21,Buffer.alloc(1024));assert.equal(g.chunks,undefined);
  assert.throws(()=>g.handle(0,Buffer.alloc(1)));
});

test('opaque mod payload with overflowing length is discarded without losing the next KeepAlive frame', () => {
  for (const profile of ['mcskill','standard']) {
    const sent=[], events=[];
    const g=new GameSessionHandler({send:(...args)=>sent.push(args),plugin(){},forge:{profile},log:{event:(...args)=>events.push(args)},joined(){},positioned(){}});
    // Synthetic reproducer, not a captured server payload. The old handler
    // treated ffffff as a length sentinel and decoded mod bytes as a VarInt.
    const body=concat(string('ExampleMod'),Buffer.from('ffffffffffffffff','hex'),Buffer.alloc(33200,0xa5));
    const wire=concat(packet(0x3f,body),packet(0,i32(1710)));
    const codec=new PacketCodec();
    for(let p=0;p<wire.length;p+=137) codec.feed(wire.subarray(p,p+137),frame=>{
      const r=new Reader(frame);g.handle(r.vi(),r.bytes(r.remaining));
    });
    assert.equal(g.unknownPayloads,1);assert.equal(g.keepAlives,1);
    assert.deepEqual(sent,[[0,i32(1710)]]);
    assert.equal(events[0][0],'unhandled_mod_payload');
    assert.deepEqual(Object.keys(events[0][1]),['bytes']);
    for(let i=0;i<100;i++)g.handle(0x3f,body);
    assert.equal(events.length,1);assert.equal(g.unknownPayloads,101);
  }
});

test('Forge handshake and channel registration still require valid inner lengths', () => {
  const payloads=[];
  const g=new GameSessionHandler({send(){},plugin(){},forge:{profile:'mcskill',handle:b=>payloads.push(b)},log,joined(){},positioned(){}});
  for(const channel of ['FML|HS','REGISTER','UNREGISTER']) {
    assert.throws(()=>g.handle(0x3f,concat(string(channel),Buffer.from('ffffffffffffffff','hex'))),{code:'PROTOCOL'});
    assert.throws(()=>g.handle(0x3f,concat(string(channel),i16(20),Buffer.alloc(2))),{code:'PROTOCOL'});
  }
  g.handle(0x3f,concat(string('FML|HS'),i16(2),Buffer.from([255,3])));
  assert.deepEqual(payloads,[Buffer.from([255,3])]);
  g.handle(0x3f,concat(string('REGISTER'),i16(3),Buffer.from('a\0b')));
  assert.equal(g.channelCount,2);
});
