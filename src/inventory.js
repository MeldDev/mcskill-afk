import { createHash } from 'node:crypto';
import { Reader, ProtocolError, concat, i16 } from './codec.js';
function item(r, extended) {
  const start = r.p, id = r.i16();
  if (id === -1) return null;
  if (id < 0) throw new ProtocolError('Invalid item ID');
  const count = r.u8(), damage = r.i16(), length = r.i16();
  if (length < -1) throw new ProtocolError('Invalid item NBT length');
  if (length >= 0) r.bytes(length);
  // Locally verified LuxinfinePacketUnlimitter: short bytes, then extra int+bytes.
  if (extended && length === 32767) r.bytes(r.i32());
  const fingerprint = createHash('sha256').update(r.b.subarray(start,r.p)).digest('hex');
  return count ? { id, count, damage, fingerprint } : null;
}
export class InventoryHandler {
  constructor({send, profile, status = () => {}}) {
    Object.assign(this,{send,profile,status}); this.slots=Array(45).fill(null); this.ready=false;
    this.cursor=null; this.window=0; this.revision=0; this.action=0;
  }
  setSlot(slot, value) {
    if (this.slots[slot]?.fingerprint !== value?.fingerprint) this.revision++;
    this.slots[slot]=value;
  }
  handle(id, body) {
    const r=new Reader(body), extended=this.profile==='mcskill';
    if (id===0x30) {
      const window=r.u8(), n=r.i16();
      if(n<0||n>512)throw new ProtocolError('Inventory slot count limit');
      for(let i=0;i<n;i++){const value=item(r,extended);if(window===0&&i<45)this.setSlot(i,value);}
      r.end();
      if(window===0){this.ready=n===45;if(!this.ready)this.cancel('INVENTORY_LAYOUT_UNSUPPORTED');}
    } else if(id===0x2f) {
      const window=r.i8(), slot=r.i16(), value=item(r,extended);r.end();
      if(window===-1&&slot===-1){this.cursor=value;this.revision++;if(value)this.cancel('CURSOR_NOT_EMPTY');}
      else if(window===0&&slot>=0&&slot<45)this.setSlot(slot,value);
    } else if(id===0x2d) {
      this.window=r.u8();this.ready=false;this.cancel('WINDOW_OPEN');
    } else if(id===0x2e) {
      const window=r.u8();r.end();if(window===this.window)this.window=0;
    } else if(id===0x32) {
      const window=r.u8(), action=r.i16(), accepted=r.u8();r.end();
      const pending=this.drop?.pending;
      if(pending&&window===0&&action===pending.action){
        if(!accepted)this.cancel('DROP_REJECTED');else pending.acked=true;
      }
    }
  }
  snapshot() {
    if(!this.ready)throw new Error('INVENTORY_NOT_READY');
    if(this.window!==0)throw new Error('WINDOW_OPEN');
    if(this.cursor)throw new Error('CURSOR_NOT_EMPTY');
    if(this.drop)throw new Error('DROP_BUSY');
    return {revision:this.revision, slots:this.slots.flatMap((value,slot)=>slot>=1&&value?[{slot,...value}]:[])};
  }
  startDrop(plan) {
    this.snapshot();
    if(plan.revision!==this.revision)throw new Error('INVENTORY_CHANGED');
    this.drop={slots:plan.slots.map(x=>({...x})),index:0,completed:0,pending:null,nextAt:0};
    this.status({code:'DROP_STARTED',count:plan.slots.length});
  }
  tick(now=Date.now()) {
    const job=this.drop;if(!job)return;
    if(!this.ready||this.window!==0||this.cursor){this.cancel('INVENTORY_CHANGED');return;}
    if(job.pending){
      const p=job.pending, current=this.slots[p.slot];
      if(now>=p.deadline){this.cancel('DROP_TIMEOUT');return;}
      if(p.acked&&!current){job.completed++;job.index++;job.pending=null;job.nextAt=now+300;}
      else if(current&&current.fingerprint!==p.fingerprint)this.cancel('INVENTORY_CHANGED');
      return;
    }
    if(job.index===job.slots.length){this.drop=null;this.status({code:'DROP_COMPLETE',count:job.completed});return;}
    if(now<job.nextAt)return;
    const target=job.slots[job.index];
    if(this.slots[target.slot]?.fingerprint!==target.fingerprint){this.cancel('INVENTORY_CHANGED');return;}
    this.action=this.action>=32767?1:this.action+1;
    job.pending={slot:target.slot,fingerprint:target.fingerprint,action:this.action,acked:false,deadline:now+5000};
    // C0E: window=0, mode=4, button=1 (whole stack), returned clicked item=null.
    // Container.slotClick's mode 4 returns null; never invent or echo an item/NBT.
    this.send(0x0e,concat(Buffer.from([0]),i16(target.slot),Buffer.from([1]),i16(this.action),Buffer.from([4]),i16(-1)));
  }
  cancel(code='DROP_CANCELLED') {
    if(this.drop){const count=this.drop.completed;this.drop=null;this.status({code,count});}
  }
  invalidate() {this.cancel('DROP_CANCELLED');this.ready=false;this.revision++;}
}
