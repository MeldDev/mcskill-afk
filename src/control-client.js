import net from 'node:net';
import { EventEmitter } from 'node:events';

export class ControlClient extends EventEmitter {
  async connect(path) {
    this.socket=net.createConnection(path);let pending=Buffer.alloc(0);
    this.socket.on('data',chunk=>{
      let p=0;
      try {
        while(p<chunk.length){
          const end=chunk.indexOf(10,p), stop=end<0?chunk.length:end;
          if(pending.length+stop-p>65536)throw new Error('CONTROL_RESPONSE_LIMIT');
          pending=Buffer.concat([pending,chunk.subarray(p,stop)]);p=stop+1;
          if(end<0)break;
          const message=JSON.parse(pending.toString('utf8'));pending=Buffer.alloc(0);
          if(message.type==='hello'){this.connected=true;this.emit('hello',message);}
          else if(message.type==='output'&&typeof message.text==='string')this.emit('output',message.text);
          else if(message.type==='done'&&this.request){const request=this.request;this.request=null;clearTimeout(request.timer);request.resolve(message.ok===true);}
          else throw new Error('CONTROL_RESPONSE_INVALID');
        }
      } catch { this.socket.destroy(); }
    });
    this.socket.on('error',()=>{});
    this.socket.on('close',()=>{
      this.connected=false;
      if(this.request){clearTimeout(this.request.timer);this.request.reject(new Error('CONTROL_CLOSED'));this.request=null;}
      this.emit('closed');
    });
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(new Error('CONTROL_CONNECT_TIMEOUT')),5000);
      const hello=()=>finish(), closed=()=>finish(new Error('CONTROL_UNAVAILABLE'));
      const finish=error=>{
        clearTimeout(timer);this.off('hello',hello);this.off('closed',closed);
        if(error){this.socket.destroy();reject(error);}else resolve();
      };
      this.once('hello',hello);this.once('closed',closed);
    });
    return this;
  }
  command(line) {
    if(typeof line!=='string'||!line.trim()||Buffer.byteLength(line)>1024||/[\r\n\0]/.test(line))return Promise.reject(new Error('CONTROL_COMMAND_INVALID'));
    if(!this.connected||this.socket.destroyed)return Promise.reject(new Error('CONTROL_UNAVAILABLE'));
    if(this.request)return Promise.reject(new Error('CONTROL_BUSY'));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        this.request=null;this.socket.destroy();reject(new Error('CONTROL_COMMAND_TIMEOUT'));
      },5000);
      this.request={resolve,reject,timer};this.socket.write(line+'\n');
    });
  }
  close(){this.socket?.destroy();}
}
