import { test } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { once } from 'node:events';
import { concat, varint, Reader } from '../src/codec.js';
import { encodeLogin, decodeLogin, grpcFrame, grpcMessage, loginRpc, passwordLogin } from '../src/launcher-auth.js';
const field=(id,b)=>{b=Buffer.isBuffer(b)?b:Buffer.from(b);return concat(varint(id*8+2),varint(b.length),b)};
const response=()=>field(3,concat(field(1,'FAKE_SECOND_TOKEN'),field(2,concat(field(1,'00000000-0000-0000-0000-000000000002'),field(2,'SecondPlayer')))));
test('official launcher protobuf request and session response',()=>{
 const r=new Reader(encodeLogin('SecondPlayer','FAKE_PASSWORD'));
 assert.equal(r.vi(),10);assert.equal(r.str(),'SecondPlayer');assert.equal(r.vi(),18);assert.equal(r.str(),'FAKE_PASSWORD');r.end();
 assert.deepEqual(decodeLogin(response()),{username:'SecondPlayer',uuid:'00000000000000000000000000000002',accessToken:'FAKE_SECOND_TOKEN'});
});
test('MFA and TOTP challenges stop login; malformed/ambiguous replies are rejected',()=>{
 for(const [id,code] of [[4,'LOGIN_MFA_REQUIRED'],[5,'LOGIN_TOTP_REQUIRED']])assert.throws(()=>decodeLogin(field(id,Buffer.alloc(0))),e=>e.code===code);
 for(const b of [Buffer.alloc(0),Buffer.from([26,255]),concat(response(),field(4,Buffer.alloc(0))),field(3,Buffer.alloc(0))])assert.throws(()=>decodeLogin(b),e=>e.code==='LOGIN_RESPONSE_INVALID');
});
test('gRPC envelope rejects compressed, truncated and multiple messages',()=>{
 const p=response();assert.deepEqual(grpcMessage(grpcFrame(p)),p);
 const b=grpcFrame(p);b[0]=1;assert.throws(()=>grpcMessage(b));assert.throws(()=>grpcMessage(Buffer.alloc(3)));assert.throws(()=>grpcMessage(concat(grpcFrame(p),grpcFrame(p))));
});
test('password login uses official regional origin and clears encoded credential buffer',async()=>{
 let request;
 const s=await passwordLogin('SecondPlayer','FAKE_PASSWORD','https://auth.mcskill.net',undefined,async(origin,b)=>{
  assert.equal(origin,'https://launchernew.mcskill.net');request=b;assert.ok(b.includes(Buffer.from('FAKE_PASSWORD')));return response();
 });
 assert.equal(s.username,'SecondPlayer');assert.ok(request.every(x=>x===0));
 await assert.rejects(passwordLogin('x','p','https://example.com'),e=>e.code==='LOGIN_ORIGIN_INVALID');
});
test('HTTP2 gRPC transport handles fragmented data and trailers over localhost',async t=>{
 const server=http2.createServer();const sessions=new Set();server.on('session',s=>{sessions.add(s);s.on('error',()=>{});s.on('close',()=>sessions.delete(s))});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{for(const s of sessions)s.destroy();await new Promise(r=>server.close(r))});
 let request;
 server.on('stream',(s,h)=>{
  assert.equal(h[':path'],'/launcher.AuthService/Login');assert.equal(h['x-region'],'ru');assert.equal(h.session,undefined);
  const chunks=[];s.on('data',b=>chunks.push(b));s.on('end',()=>{
   request=grpcMessage(Buffer.concat(chunks));s.respond({':status':200,'content-type':'application/grpc'},{waitForTrailers:true});
   s.once('wantTrailers',()=>s.sendTrailers({'grpc-status':'0'}));
   const b=grpcFrame(response());for(let i=0;i<b.length;i+=3)s.write(b.subarray(i,i+3));s.end();
  });
 });
 const result=await loginRpc('https://launchernew.mcskill.ru',encodeLogin('SecondPlayer','FAKE_PASSWORD'),undefined,()=>http2.connect(`http://127.0.0.1:${server.address().port}`));
 assert.equal(decodeLogin(result).username,'SecondPlayer');assert.ok(request.includes(Buffer.from('FAKE_PASSWORD')));
});
test('gRPC rejects unofficial origins and cancelled requests before network access',async()=>{
 assert.throws(()=>loginRpc('https://example.com',Buffer.alloc(0)),e=>e.code==='LOGIN_ORIGIN_INVALID');
 const c=new AbortController();c.abort();await assert.rejects(loginRpc('https://launchernew.mcskill.ru',Buffer.alloc(0),c.signal),e=>e.code==='LOGIN_CANCELLED');
});
