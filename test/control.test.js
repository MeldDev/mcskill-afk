import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, chmod, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ControlServer } from '../src/control-server.js';
import { ControlClient } from '../src/control-client.js';

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'mcskill-control-'));
  if(process.platform!=='win32')await chmod(dir,0o700);
  const path=process.platform==='win32'?`\\\\.\\pipe\\mcskill-test-${randomBytes(12).toString('hex')}`:join(dir,'control.sock');
  const stop=new AbortController(), sent=[], events=[];
  const log={write(){},event:(...args)=>events.push(args)}, originalWrite=log.write;
  const server=await new ControlServer({path,stop,log}).start();
  const clients=[];
  const connect=async()=>{
    const client=new ControlClient(), output=[];client.on('output',text=>output.push(text));
    clients.push(client);await client.connect(path);return{client,output};
  };
  const connection=new EventEmitter();let drops=0;
  Object.assign(connection,{ready:true,forge:{done:true},game:{position:{},inventory:{
    slots:Array(45).fill(null),snapshot:()=>({slots:[{slot:9,id:1,count:64,damage:0}]}),
    startDrop(){drops++},cancel(){} }},sendChat:line=>sent.push(line)});
  server.setConnection(connection);
  t.after(async()=>{for(const client of clients)client.close();await server.close();await rm(dir,{recursive:true,force:true});});
  return{path,dir,stop,sent,events,log,originalWrite,server,connection,connect,get drops(){return drops}};
}

test('control socket routes chat, commands and responses without touching the process logger',async t=>{
  const f=await fixture(t), {client,output}=await f.connect();
  assert.equal(await client.command('hello'),true);
  assert.equal(await client.command('/help'),true);assert.deepEqual(f.sent,['hello','/help']);
  assert.equal(await client.command(':inventory'),true);assert.ok(output.some(s=>s.includes('id=1')));
  assert.equal(await client.command(':unknown'),false);
  assert.equal(f.log.write,f.originalWrite);assert.ok(!JSON.stringify(f.events).includes('hello'));
  const chat=once(client,'output');f.connection.emit('chat',':dropall');
  assert.equal((await chat)[0],'[CHAT] :dropall');assert.equal(f.drops,0);
  const closed=once(client,'closed');assert.equal(await client.command(':quit'),true);await closed;
  assert.equal(f.stop.signal.aborted,false);
});

test('drop confirmation belongs to one console and is cleared on reconnect',async t=>{
  const f=await fixture(t), a=await f.connect(), b=await f.connect();
  assert.equal(await a.client.command(':dropall'),true);assert.equal(f.drops,0);
  const code=a.output.join('\n').match(/:confirm ([A-F0-9]{6})/)[1];
  assert.equal(await b.client.command(':confirm '+code),false);assert.equal(f.drops,0);
  assert.equal(await a.client.command(':confirm '+code),true);assert.equal(f.drops,1);
  await a.client.command(':dropall');
  const next=a.output.join('\n').matchAll(/:confirm ([A-F0-9]{6})/g);const nextCode=[...next].at(-1)[1];
  f.connection.emit('ended');assert.equal(f.server.connection,null);
  assert.equal(await a.client.command(':confirm '+nextCode),false);
  assert.equal(await a.client.command('/spawn'),false);assert.deepEqual(f.sent,[]);
  f.server.setConnection(f.connection);
  assert.equal(await a.client.command(':confirm '+nextCode),false);assert.equal(f.drops,1);
});

test('detaching a controller leaves the bot and other controllers running',async t=>{
  const f=await fixture(t), a=await f.connect(), b=await f.connect();
  const closed=once(a.client,'closed');a.client.close();await closed;
  assert.equal(await b.client.command('still here'),true);assert.deepEqual(f.sent,['still here']);
  assert.equal(f.stop.signal.aborted,false);
});

test('control input bounds and connection limit do not execute overflow commands',async t=>{
  const f=await fixture(t), {client}=await f.connect();
  await assert.rejects(client.command('hello\n:dropall'),/CONTROL_COMMAND_INVALID/);
  await assert.rejects(client.command('x'.repeat(1025)),/CONTROL_COMMAND_INVALID/);
  const raw=net.createConnection(f.path);raw.resume();await once(raw,'connect');
  const closed=once(raw,'close');raw.write(Buffer.alloc(1025,65));await closed;assert.deepEqual(f.sent,[]);
  await f.connect();await f.connect();await f.connect();
  const extra=new ControlClient();await assert.rejects(extra.connect(f.path),/CONTROL_UNAVAILABLE/);
  assert.ok(f.server.clients.size<=4);assert.equal(await client.command(':help'),true);
});

test('control endpoint is private on Unix and existing files are never removed', {skip:process.platform==='win32'},async t=>{
  const f=await fixture(t);assert.equal((await stat(f.path)).mode&0o777,0o600);
  const existing=join(f.dir,'existing');await writeFile(existing,'keep');
  await assert.rejects(new ControlServer({path:existing,stop:f.stop,log:f.log}).start(),/CONTROL_SOCKET_EXISTS/);
  assert.equal((await stat(existing)).size,4);
  await chmod(f.dir,0o755);
  await assert.rejects(new ControlServer({path:join(f.dir,'unsafe.sock'),stop:f.stop,log:f.log}).start(),/CONTROL_DIRECTORY_UNSAFE/);
});

test('one-shot control script sends one command and returns failures without stopping the service',async t=>{
  const f=await fixture(t);
  const run=command=>promisify(execFile)(process.execPath,[fileURLToPath(new URL('../tools/control.js',import.meta.url)),'--command',command],
    {env:{...process.env,MC_CONTROL_SOCKET:f.path},timeout:10000,windowsHide:true});
  await run('/help');assert.deepEqual(f.sent,['/help']);
  await assert.rejects(run(':bad-command'),e=>e.code===1);
  const result=await run(':dropall');assert.match(result.stdout,/:confirm [A-F0-9]{6}/);assert.equal(f.drops,0);
  const code=result.stdout.match(/:confirm ([A-F0-9]{6})/)[1];
  await assert.rejects(run(':confirm '+code),e=>e.code===1);assert.equal(f.drops,0);
  await run(':quit');assert.equal(f.stop.signal.aborted,false);
  f.connection.emit('ended');await assert.rejects(run('/spawn'),e=>e.code===1);assert.deepEqual(f.sent,['/help']);
});
