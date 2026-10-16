import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoff, reconnect } from '../src/reconnect.js';
import { config } from '../src/config.js';
import { disconnectCode } from '../src/disconnect.js';
const log={event(){}};
test('default policy is fixed one minute with unlimited retries',()=>{
 const c=config({});assert.equal(c.reconnectMode,'fixed');assert.equal(c.reconnectInterval,60000);assert.equal(c.maxAttempts,-1);
 assert.throws(()=>config({MC_RECONNECT_MODE:'invalid'}));assert.throws(()=>config({MC_MAX_RETRIES:'-2'}));
});
test('unlimited mode keeps a fixed minute delay beyond the old retry limit',async()=>{
 const c=config({}), stop=new AbortController(), delays=[];let attempts=0;
 const code=await reconnect(c,async()=>{attempts++;return{error:{code:'NETWORK',retryable:true},stableMs:0}},log,stop.signal,async ms=>{
  delays.push(ms);if(delays.length===25)stop.abort();
 });
 assert.equal(code,0);assert.equal(attempts,25);assert.deepEqual(delays,Array(25).fill(60000));
});
test('fixed interval respects an explicit retry limit',async()=>{
 const delays=[];let attempts=0;
 const code=await reconnect(config({MC_MAX_RETRIES:'2'}),async()=>{attempts++;return{error:{retryable:true},stableMs:0}},log,new AbortController().signal,async ms=>delays.push(ms));
 assert.equal(code,1);assert.equal(attempts,3);assert.deepEqual(delays,[60000,60000]);
});
test('Ctrl+C/SIGTERM abort signal interrupts the real minute wait',async()=>{
 const stop=new AbortController();let attempts=0;
 const result=reconnect(config({}),async()=>{attempts++;setImmediate(()=>stop.abort());return{error:{retryable:true},stableMs:0}},log,stop.signal);
 assert.equal(await result,0);assert.equal(attempts,1);
});
test('exponential backoff and maximum',()=>{assert.equal(backoff(1,1000,5000,()=>0.5),1000);assert.equal(backoff(3,1000,5000,()=>0.5),4000);assert.equal(backoff(1000,1000,5000,()=>1),5000);});
test('network failures exhaust configured retries',async()=>{
 let attempts=0;const delays=[];
 const code=await reconnect({maxAttempts:2,reconnectBase:1000,reconnectMax:10000,stableMs:5000},async()=>{attempts++;return{error:{code:'NETWORK',retryable:true},stableMs:0}},log,new AbortController().signal,async ms=>{delays.push(ms)});
 assert.equal(code,1);assert.equal(attempts,3);assert.equal(delays.length,2);
});
test('auth rejection never retries; stop aborts backoff',async()=>{
 let attempts=0;const c={maxAttempts:10,reconnectBase:1000,reconnectMax:10000,stableMs:5000};
 await reconnect(c,async()=>{attempts++;return{error:{retryable:false}}},log,new AbortController().signal);assert.equal(attempts,1);
 const stop=new AbortController();
 const code=await reconnect(c,async()=>({error:{retryable:true}}),log,stop.signal,async()=>{stop.abort();throw new Error('abort')});assert.equal(code,0);
});
test('successful reconnection after network failure',async()=>{
 let n=0;const code=await reconnect({maxAttempts:2,reconnectBase:1000,reconnectMax:2000,stableMs:5000},async()=>++n===1?{error:{code:'NETWORK',retryable:true},stableMs:0}:{},log,new AbortController().signal,async()=>{});
 assert.equal(n,2);assert.equal(code,0);
});
test('restart -> repeated generic login refusals -> recovery keeps one-minute cycling',async()=>{
 const c=config({}),delays=[];let attempts=0;
 const result=await reconnect(c,async()=>{
  attempts++;
  if(attempts===1)return{ready:true,stableMs:600000,error:{code:'SERVER_RESTART',retryable:true}};
  if(attempts<=26)return{ready:false,stableMs:0,error:{code:disconnectCode('Disconnected','LOGIN'),retryable:true}};
  return{ready:true};
 },log,new AbortController().signal,async ms=>delays.push(ms));
 assert.equal(result,0);assert.equal(attempts,27);assert.deepEqual(delays,Array(26).fill(60000));
});
test('explicit session rejection still stops after a restart',async()=>{
 let attempts=0;const delays=[];
 const code=await reconnect(config({}),async()=>{
  attempts++;
  if(attempts===1)return{error:{code:'SERVER_RESTART',retryable:true}};
  return{error:{code:disconnectCode('Invalid session','LOGIN'),retryable:false}};
 },log,new AbortController().signal,async ms=>delays.push(ms));
 assert.equal(code,1);assert.equal(attempts,2);assert.deepEqual(delays,[60000]);
});

test('multi-hour restart, post-world decoding error, and next successful connection keep minute retries',async()=>{
 let attempts=0;const delays=[];
 const code=await reconnect(config({}),async()=>{
  attempts++;
  if(attempts<=104)return{error:{code:'REMOTE_CLOSED',retryable:true},stableMs:0};
  if(attempts===105)return{ready:true,stableMs:175,error:{code:'PROTOCOL',retryable:true}};
  return{ready:true};
 },log,new AbortController().signal,async ms=>delays.push(ms));
 assert.equal(code,0);assert.equal(attempts,106);assert.deepEqual(delays,Array(105).fill(60000));
});
