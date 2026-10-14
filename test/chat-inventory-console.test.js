import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { formatChat, safeConsoleText, validateChat } from '../src/chat.js';
import { InventoryHandler } from '../src/inventory.js';
import { ConsoleController } from '../src/console.js';
import { MinecraftConnection } from '../src/connection.js';
import { GameSessionHandler } from '../src/game.js';
import { Reader, concat, i16, i32, string } from '../src/codec.js';
const stack=(id=1,count=64,nbt=null)=>concat(i16(id),Buffer.from([count]),i16(0),nbt?concat(i16(nbt.length),nbt):i16(-1));
const items=(entries={})=>concat(Buffer.from([0]),i16(45),...Array.from({length:45},(_,i)=>entries[i]||i16(-1)));
const slot=(index,value=i16(-1))=>concat(Buffer.from([0]),i16(index),value);
const ack=(action,accepted=1)=>concat(Buffer.from([0]),i16(action),Buffer.from([accepted]));
function inventory(entries={9:stack()},profile='standard'){
 const sent=[],statuses=[];const inv=new InventoryHandler({profile,send:(...a)=>sent.push(a),status:s=>statuses.push(s)});inv.handle(0x30,items(entries));return{inv,sent,statuses};
}
test('chat JSON text, translation, extras and legacy formatting become readable console text',()=>{
 assert.equal(formatChat(JSON.stringify({translate:'chat.type.text',with:[{text:'Alice',color:'gold'},{text:'Привет',extra:[{text:'!'}]}]})),'<Alice> Привет!');
 assert.equal(formatChat('§aПривет'),'Привет');assert.equal(formatChat('{bad json'),'{bad json');
 assert.equal(formatChat(JSON.stringify({text:'x',clickEvent:{action:'run_command',value:'/danger'},hoverEvent:{value:'secret'}})),'x');
});
test('chat cannot inject console control sequences, fake input lines or unlimited text',()=>{
 assert.equal(safeConsoleText('\x1b[31mhello\x1b[0m\n> fake\x07\u202e'),'hello ↵ > fake');
 assert.equal(formatChat(JSON.stringify({text:'x'.repeat(20000)})).length,8192);
 for(const s of ['','a'.repeat(101),'bad\nline','§abad'])assert.throws(()=>validateChat(s));
 assert.equal(validateChat('/spawn'),'/spawn');assert.equal(validateChat('Привет'), 'Привет');
});
test('chat send uses protocol 5 C01, requires a ready world and enforces rate limit',()=>{
 const sent=[];const c=new MinecraftConnection({}, {}, [], {event(){}});
 c.send=(...args)=>sent.push(args);
 assert.throws(()=>c.sendChat('hello'),/NOT_IN_WORLD/);
 c.ready=true;c.game={position:{}};c.forge={done:true};c.sendChat('/spawn');
 const [id,body]=sent[0];assert.equal(id,1);const r=new Reader(body);assert.equal(r.str(),'/spawn');r.end();
 assert.throws(()=>c.sendChat('again'),/CHAT_RATE_LIMIT/);assert.equal(sent.length,1);
});
test('inventory tracks bounded metadata, includes armor/crafting and omits crafting output',()=>{
 const {inv,sent}=inventory({0:stack(2),1:stack(3,1),5:stack(4,1),36:stack(5,32)});
 const plan=inv.snapshot();assert.deepEqual(plan.slots.map(s=>s.slot),[1,5,36]);assert.equal(sent.length,0);assert.equal(inv.slots.length,45);
 assert.equal(inv.slots[36].count,32);assert.equal(inv.slots[36].nbt,undefined);
});
test('NBT is skipped without decompression, including verified extended short format',()=>{
 const extra=Buffer.from([1,2,3]);const raw=concat(i16(1),Buffer.from([1]),i16(0),i16(32767),Buffer.alloc(32767),i32(extra.length),extra);
 const {inv}=inventory({9:raw},'mcskill');assert.equal(inv.slots[9].id,1);assert.equal(inv.slots[9].fingerprint.length,64);
 assert.throws(()=>inv.handle(0x2f,slot(9,raw.subarray(0,-1))));
});
test('whole-stack drop waits for both accepted transaction and empty slot with a gap',()=>{
 const {inv,sent,statuses}=inventory({9:stack(1),36:stack(2,32)});
 inv.startDrop(inv.snapshot());assert.equal(sent.length,0);inv.tick(1000);assert.equal(sent.length,1);
 const [id,body]=sent[0], r=new Reader(body);assert.equal(id,14);assert.equal(r.u8(),0);assert.equal(r.i16(),9);assert.equal(r.u8(),1);const action=r.i16();assert.equal(r.u8(),4);assert.equal(r.i16(),-1);r.end();
 inv.handle(0x32,ack(action));inv.tick(1050);assert.equal(sent.length,1);
 inv.handle(0x2f,slot(9));inv.tick(1100);inv.tick(1399);assert.equal(sent.length,1);inv.tick(1400);assert.equal(sent.length,2);
 const second=new Reader(sent[1][1]);second.bytes(4);const secondAction=second.i16();
 inv.handle(0x2f,slot(36));inv.tick(1450);assert.ok(inv.drop.pending);
 inv.handle(0x32,ack(secondAction));inv.tick(1500);inv.tick(1550);
 assert.equal(inv.drop,null);assert.deepEqual(statuses.at(-1),{code:'DROP_COMPLETE',count:2});
});
test('reject, timeout, changed inventory and cancellation stop future drop packets',()=>{
 for(const reason of ['reject','timeout','changed','cancel']){
  const {inv,sent,statuses}=inventory({9:stack(),10:stack(2)});inv.startDrop(inv.snapshot());inv.tick(1000);
  if(reason==='reject')inv.handle(0x32,ack(1,0));
  if(reason==='timeout')inv.tick(6000);
  if(reason==='changed')inv.handle(0x2f,slot(9,stack(3)));
  if(reason==='cancel')inv.cancel();
  inv.tick(7000);assert.equal(inv.drop,null);assert.equal(sent.length,1);assert.notEqual(statuses.at(-1).code,'DROP_COMPLETE');
 }
});
test('unknown inventory, open container, nonempty cursor and stale confirmation cannot drop',()=>{
 const {inv,sent}=inventory();const plan=inv.snapshot();inv.handle(0x2f,slot(10,stack(2)));assert.throws(()=>inv.startDrop(plan),/INVENTORY_CHANGED/);
 inv.handle(0x2f,concat(Buffer.from([255]),i16(-1),stack()));assert.throws(()=>inv.snapshot(),/CURSOR_NOT_EMPTY/);
 inv.handle(0x2d,Buffer.from([1]));assert.throws(()=>inv.snapshot(),/INVENTORY_NOT_READY/);inv.handle(0x2e,Buffer.from([1]));assert.throws(()=>inv.snapshot(),/INVENTORY_NOT_READY/);
 assert.equal(sent.length,0);
});
function consoleFixture(){
 const input=new PassThrough(),output=new PassThrough(),stop=new AbortController(),lines=[];output.on('data',b=>lines.push(b.toString()));
 const logger={write(){}};const ui=new ConsoleController({input,output,stop,log:logger,chatEnabled:true});
 const c=new EventEmitter(), state=inventory({9:stack()});Object.assign(c,{ready:true,forge:{done:true},game:{position:{},inventory:state.inv},sendChat:text=>state.sent.push(['chat',text])});
 ui.setConnection(c);return{ui,c,lines,stop,...state};
}
test('console chat and local commands are separated; server chat never executes actions',()=>{
 const {ui,c,lines,sent,stop}=consoleFixture();
 c.emit('chat',':dropall');assert.equal(sent.length,0);assert.ok(lines.join('').includes('[CHAT] :dropall'));
 ui.handleLine('hello');ui.handleLine('/spawn');ui.handleLine(':inventory');assert.deepEqual(sent,[['chat','hello'],['chat','/spawn']]);
 ui.handleLine(':quit');assert.ok(stop.signal.aborted);ui.close();
});
test('drop requires an unexpired matching local confirmation and never resumes on reconnect',()=>{
 const {ui,c,inv,sent}=consoleFixture();
 ui.handleLine(':dropall');assert.equal(sent.length,0);const code=ui.confirmation.code;
 ui.handleLine(':confirm WRONG');assert.equal(inv.drop,undefined);
 ui.handleLine(':confirm '+code);assert.ok(inv.drop);inv.tick(1000);assert.equal(sent.length,1);
 inv.cancel();ui.handleLine(':dropall');ui.confirmation.expires=0;ui.handleLine(':confirm '+ui.confirmation.code);assert.equal(inv.drop,null);
 ui.handleLine(':dropall');c.emit('ended');assert.equal(ui.confirmation,null);ui.handleLine(':confirm '+code);assert.equal(sent.length,1);ui.close();
});
test('console output applies backpressure and restores its logger on close',()=>{
 const {ui,lines}=consoleFixture();const original=ui.previousWrite;
 Object.defineProperty(ui.output,'writableLength',{value:300000,configurable:true});ui.writeLine('do not queue');assert.equal(ui.skipped,1);
 Object.defineProperty(ui.output,'writableLength',{value:0,configurable:true});ui.writeLine('next');assert.ok(lines.join('').includes('Пропущено строк'));ui.close();assert.equal(ui.log.write,original);
});
test('game handler emits chat and rejects/acknowledges inventory transactions correctly',()=>{
 const sent=[],chat=[];const g=new GameSessionHandler({send:(...a)=>sent.push(a),plugin(){},forge:{done:true},log:{event(){}},joined(){},positioned(){},chat:s=>chat.push(s)});
 g.handle(2,string('{"text":"hello"}'));assert.deepEqual(chat,['hello']);g.handle(0x30,items({9:stack()}));g.inventory.startDrop(g.inventory.snapshot());g.inventory.tick(1000);assert.equal(sent[0][0],14);g.handle(0x32,ack(1,0));
 assert.equal(g.inventory.drop,null);assert.equal(sent.at(-1)[0],15);assert.equal(sent.at(-1)[1][3],1);
});
test('incoming chat and diagnostics preserve a partially typed console message',()=>{
 const input=new PassThrough(),output=new PassThrough(),stop=new AbortController();
 input.isTTY=true;input.setRawMode=()=>{};output.isTTY=true;output.columns=100;output.on('data',()=>{});
 const logger={write(){}};const ui=new ConsoleController({input,output,stop,log:logger});
 input.write('draft');assert.equal(ui.rl.line,'draft');ui.writeLine('[CHAT] hello');logger.write('diagnostic');assert.equal(ui.rl.line,'draft');ui.close();
});
