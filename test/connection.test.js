import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { MinecraftConnection } from '../src/connection.js';
import { PacketCodec, Reader, concat, packet, string, i16, i32, shortBuffer } from '../src/codec.js';
import { aes, serverHash } from '../src/encryption.js';
import { config } from '../src/config.js';
const session={username:'MockPlayer',uuid:'00000000000000000000000000000001',accessToken:'FAKE_TEST_TOKEN'};
const log={event(){}};
async function mock(t, handle) {
  const sockets=new Set(); const server=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});handle(s)});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));});
  return config({MC_HOST:'127.0.0.1',MC_PORT:String(server.address().port),MC_TIMEOUT_MS:'2000',MC_IDLE_TIMEOUT_MS:'2000',MC_TEST_DURATION_MS:'1000'});
}
for (const injectProtocolFailure of [false,true]) test(injectProtocolFailure ?
  'unknown in-world packet closes encrypted TCP and permits a clean reconnect' :
  'end-to-end encrypted login, FML, Join Game, position and KeepAlive over real TCP',async t=>{
  const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:1024});
  const der=publicKey.export({type:'spki',format:'der'}), verify=Buffer.from([1,2,3,4]);
  let joinHash, keepAliveReply=false, movement=false, encrypted=false, serverError, chatSent=false, dropped=false;
  const incomingChat=[];
  const c=await mock(t,s=>{
    const codec=new PacketCodec();let state='HANDSHAKE',crypto;
    const send=(id,body)=>{const b=packet(id,body);s.write(crypto?crypto.encrypt.update(b):b)};
    const plugin=data=>send(63,concat(string('FML|HS'),shortBuffer(data)));
    const decrypt=b=>{const p=privateDecrypt({key:privateKey,padding:constants.RSA_NO_PADDING},b);return p.subarray(p.indexOf(0,2)+1)};
    s.on('data',b=>{try{codec.feed(crypto?crypto.decrypt.update(b):b,frame=>{
      const r=new Reader(frame),id=r.vi();
      if(state==='HANDSHAKE') {assert.equal(id,0);assert.equal(r.vi(),5);assert.equal(r.str(),'127.0.0.1\0FML\0');r.bytes(2);assert.equal(r.vi(),2);r.end();state='LOGIN_START';}
      else if(state==='LOGIN_START') {assert.equal(r.str(),session.username);send(1,concat(string(''),shortBuffer(der),shortBuffer(verify)));state='ENCRYPTION';}
      else if(state==='ENCRYPTION') {
        assert.equal(id,1);const secret=decrypt(r.shortBytes());assert.deepEqual(decrypt(r.shortBytes()),verify);r.end();
        assert.equal(joinHash,serverHash('',secret,der));crypto=aes(secret);encrypted=true;
        send(2,concat(string(session.uuid),string(session.username)));plugin(concat(Buffer.from([0,2]),i32(0)));state='PLAY';
      } else if(id===23) {
        const channel=r.str();const data=r.shortBytes();r.end();if(channel!=='FML|HS')return;
        if(data[0]===1)assert.equal(data.toString('hex'),'010000000002');
        else if(data[0]===2)plugin(Buffer.from([2,0]));
        else if(data[0]===255 && data[1]===2)plugin(Buffer.from([3,0,0,0]));
        else if(data[0]===255 && data[1]===3)plugin(Buffer.from([255,2]));
        else if(data[0]===255 && data[1]===4)plugin(Buffer.from([255,3]));
        else if(data[0]===255 && data[1]===5){
          send(1,concat(i32(1),Buffer.from([0,0,2,10]),string('flat'),i32(0)));
          send(0x30,concat(Buffer.from([0]),i16(45),...Array.from({length:45},(_,i)=>i===9?concat(i16(1),Buffer.from([64]),i16(0),i16(-1)):i16(-1))));
          send(2,string('{"translate":"chat.type.text","with":["Mock","hello"]}'));
          const p=Buffer.alloc(33);p.writeDoubleBE(65.62,8);send(8,p);send(0,i32(909));
          // Large unknown payload and chunk prove world data is bounded/discarded.
          send(0x21,Buffer.alloc(131072));
        }
      } else if(id===0){assert.equal(r.i32(),909);r.end();keepAliveReply=true;if(injectProtocolFailure)send(0x60,Buffer.alloc(12299));}
      else if(id===6){movement=true;assert.ok(Math.abs(r.f64())<1e-8);assert.ok(Math.abs(r.f64()-64)<1e-8);}
      else if(id===1){assert.equal(r.str(),'/help');r.end();chatSent=true;}
      else if(id===14){
        assert.equal(r.u8(),0);assert.equal(r.i16(),9);assert.equal(r.u8(),1);const action=r.i16();assert.equal(r.u8(),4);assert.equal(r.i16(),-1);r.end();dropped=true;
        send(0x32,concat(Buffer.from([0]),i16(action),Buffer.from([1])));send(0x2f,concat(Buffer.from([0]),i16(9),i16(-1)));
      }
    })}catch(e){serverError=e;s.destroy()}});
  });
  const conn=new MinecraftConnection(c,session,[],log,{async join(s,h){assert.equal(s.accessToken,'FAKE_TEST_TOKEN');joinHash=h;}});
  conn.on('chat',s=>incomingChat.push(s));
  conn.once('ready',()=>{conn.sendChat('/help');if(!injectProtocolFailure)conn.game.inventory.startDrop(conn.game.inventory.snapshot());});
  const result=await conn.start('forge-test');
  if(serverError)throw serverError;
  if(injectProtocolFailure){assert.equal(result.error.code,'PROTOCOL');assert.equal(result.error.retryable,true);assert.ok(conn.socket.destroyed);assert.ok(conn.finished);}
  else {assert.equal(result.error,undefined);assert.ok(result.reached);}
  assert.ok(result.ready);assert.ok(encrypted);assert.ok(keepAliveReply);assert.ok(movement);assert.equal(result.keepAlives,1);
  assert.deepEqual(incomingChat,['<Mock> hello']);assert.ok(chatSent);assert.ok(!conn.game.inventory.drop);
  if(!injectProtocolFailure){assert.ok(dropped);assert.equal(conn.game.inventory.slots[9],null);}
});
test('generic Login Disconnect is retryable and does not expose server text',async t=>{
  const c=await mock(t,s=>s.once('data',()=>s.end(packet(0,string('{"text":"FAKE_TEST_TOKEN"}')))));
  const result=await new MinecraftConnection(c,session,[],log).start('auth-test');assert.equal(result.error.code,'SERVER_LOGIN_RETRY');assert.equal(result.error.retryable,true);assert.ok(!result.error.message.includes('TOKEN'));
});
test('server restart Disconnect is retryable over actual TCP',async t=>{
  const c=await mock(t,s=>s.once('data',()=>s.end(packet(0,string('{"text":"Сервер перезагружается"}')))));
  const result=await new MinecraftConnection(c,session,[],log).start('auth-test');assert.equal(result.error.code,'SERVER_RESTART');assert.equal(result.error.retryable,true);
});
test('Login Success before encryption is rejected',async t=>{
  const c=await mock(t,s=>s.once('data',()=>s.write(packet(2,concat(string(session.uuid),string(session.username))))));
  const result=await new MinecraftConnection(c,session,[],log).start('auth-test');assert.equal(result.error.code,'PROTOCOL');assert.equal(result.error.retryable,false);
});
test('abort closes an active TCP socket and clears timers',async t=>{
  let sock, accepted;const ready=new Promise(r=>{accepted=r});
  const c=await mock(t,s=>{sock=s;s.resume();accepted()});const stop=new AbortController();
  const conn=new MinecraftConnection(c,session,[],log);const result=conn.start('afk',stop.signal);await ready;
  const closed=once(sock,'close');stop.abort();
  assert.equal((await result).error.code,'STOPPED');await closed;assert.ok(sock.destroyed);assert.ok(conn.socket.destroyed);assert.ok(conn.finished);
});
test('reconnect recovers an actual dropped TCP connection',async t=>{
  const {reconnect}=await import('../src/reconnect.js');let attempts=0;
  const c=await mock(t,s=>s.once('data',()=>{
    attempts++;
    if(attempts===1)s.destroy();
    else s.write(packet(1,concat(string(''),shortBuffer(Buffer.from([1])),shortBuffer(Buffer.from([1])))));
  }));
  c.maxAttempts=2;
  const code=await reconnect(c,()=>new MinecraftConnection(c,session,[],log).start('probe'),log,new AbortController().signal,async()=>{});
  assert.equal(code,0);assert.equal(attempts,2);
});
test('proxy generic login refusals keep retrying over TCP until backend returns',async t=>{
  const {reconnect}=await import('../src/reconnect.js');let attempts=0;const delays=[];
  const c=await mock(t,s=>s.once('data',()=>{
    attempts++;
    if(attempts<=3)s.end(packet(0,string('{"text":"Disconnected"}')));
    else s.write(packet(1,concat(string(''),shortBuffer(Buffer.from([1])),shortBuffer(Buffer.from([1])))));
  }));
  const code=await reconnect(c,()=>new MinecraftConnection(c,session,[],log).start('probe'),log,new AbortController().signal,async ms=>delays.push(ms));
  assert.equal(code,0);assert.equal(attempts,4);assert.deepEqual(delays,[60000,60000,60000]);
});
test('network close is retryable; malformed packet does not crash process',async t=>{
  const c=await mock(t,s=>s.once('data',()=>s.end()));
  const result=await new MinecraftConnection(c,session,[],log).start();assert.equal(result.error.code,'REMOTE_CLOSED');assert.equal(result.error.retryable,true);
});

test('inbound watchdog closes a silent TCP peer despite continuous outgoing writes',async t=>{
  let writes=0;
  const c=await mock(t,s=>s.on('data',()=>writes++));
  c.idleTimeout=1000;c.timeout=3000;
  const conn=new MinecraftConnection(c,session,[],log);
  // Exercise the active-session ticker and real socket without a live account.
  conn.game={tick:()=>conn.send(3,Buffer.from([1])),inventory:{cancel(){}},keepAlives:0};
  const result=await conn.start('afk');
  assert.equal(result.error.code,'INBOUND_TIMEOUT');assert.equal(result.error.retryable,true);
  assert.ok(writes>=5);assert.ok(conn.socket.destroyed);assert.ok(conn.finished);
  assert.ok(conn.ticker._destroyed);assert.ok(conn.metrics._destroyed);
});

test('only incoming packets refresh the independent watchdog; outgoing writes do not',()=>{
  const conn=new MinecraftConnection(config({}),session,[],log);let writes=0;
  conn.socket={writableLength:0,write(){writes++},destroy(){}};
  conn.state='PLAY';conn.game={handle(){},inventory:{cancel(){}}};
  conn.lastPacketAt=0;
  conn.send(3,Buffer.from([1]));assert.equal(conn.lastPacketAt,0);
  conn.receive(concat(Buffer.from([0]),i32(12)));
  const received=conn.lastPacketAt;
  assert.equal(conn.checkInboundTimeout(received+conn.c.idleTimeout-1),false);
  conn.send(3,Buffer.from([1]));assert.equal(conn.lastPacketAt,received);
  assert.equal(conn.checkInboundTimeout(received+conn.c.idleTimeout),true);
  assert.equal(conn.failure.code,'INBOUND_TIMEOUT');assert.equal(writes,2);
});
