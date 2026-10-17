import net from 'node:net';
import { lstat, chmod } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { ConsoleController } from './console.js';

const MAX_LINE = 1024, MAX_OUTPUT = 262144, MAX_CLIENTS = 4;
export class ControlServer {
  constructor({path,log,stop}) { Object.assign(this,{path,log,stop});this.clients=new Set();this.onEnded=()=>this.setConnection(null); }
  async start() {
    if(process.platform !== 'win32') {
      if(!isAbsolute(this.path))throw new Error('CONTROL_PATH_INVALID');
      const dir=await lstat(dirname(this.path));
      if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid()||(dir.mode&0o077))throw new Error('CONTROL_DIRECTORY_UNSAFE');
      // Do not unlink somebody else's file, an existing live endpoint or a symlink.
      try { await lstat(this.path);throw new Error('CONTROL_SOCKET_EXISTS'); }
      catch(e) { if(e.code!=='ENOENT')throw e; }
    }
    this.server=net.createServer(socket=>this.accept(socket));
    try {
      await new Promise((resolve,reject)=>{
        this.server.once('error',reject);
        this.server.listen(this.path,()=>{this.server.off('error',reject);resolve();});
      });
      if(process.platform!=='win32')await chmod(this.path,0o600);
      this.server.on('error',()=>this.log.event('control_error'));
      this.log.event('control_listening');
    } catch(e) { await this.close();throw e; }
    return this;
  }
  accept(socket) {
    if(this.clients.size>=MAX_CLIENTS){socket.destroy();return;}
    const send=value=>{
      if(socket.destroyed)return;
      const frame=JSON.stringify(value)+'\n';
      if(socket.writableLength+Buffer.byteLength(frame)>MAX_OUTPUT){socket.destroy();return;}
      socket.write(frame);
    };
    const output={get destroyed(){return socket.destroyed},get writableLength(){return socket.writableLength},
      write:line=>send({type:'output',text:line.replace(/\n$/,'')})};
    // Every console owns its confirmation; closing it cannot stop the bot or
    // restore/replace the process logger. Chat input is never written to logs.
    const ui=new ConsoleController({log:this.log,stop:this.stop,input:{},output,captureLog:false});
    const client={socket,ui};this.clients.add(client);ui.setConnection(this.connection);
    let pending=Buffer.alloc(0), window=Date.now(), count=0, detached=false;
    socket.on('error',()=>{});
    socket.on('close',()=>{this.clients.delete(client);ui.close();});
    socket.on('data',chunk=>{
      if(detached)return;
      // Process a bounded line at a time; never queue commands across reconnects.
      let p=0;
      while(p<chunk.length&&!socket.destroyed){
        const end=chunk.indexOf(10,p), stop=end<0?chunk.length:end;
        if(pending.length+stop-p>MAX_LINE){socket.destroy();return;}
        pending=Buffer.concat([pending,chunk.subarray(p,stop)]);p=stop+1;
        if(end<0)break;
        if(Date.now()-window>=1000){window=Date.now();count=0;}
        if(++count>10){socket.destroy();return;}
        const command=pending.toString('utf8').replace(/\r$/,'');pending=Buffer.alloc(0);
        if(command.trim()===':quit'){detached=true;send({type:'done',ok:true});socket.end();return;}
        const ok=ui.handleLine(command);
        send({type:'done',ok:ok!==false});
      }
    });
    send({type:'hello',ready:!!this.connection?.ready});
    ui.writeLine('Консоль управления подключена. :help — команды; :quit или Ctrl+C — отключиться от консоли. Бот продолжит работать.');
    if(!this.connection?.ready)ui.writeLine('Бот пока не в мире. Команды чата и инвентаря не ставятся в очередь.');
  }
  setConnection(connection) {
    this.connection?.off('ended',this.onEnded);
    this.connection=connection;
    connection?.once('ended',this.onEnded);
    for(const {ui} of this.clients)ui.setConnection(connection);
  }
  async close() {
    this.connection?.off('ended',this.onEnded);this.connection=null;
    for(const {socket,ui} of this.clients){ui.close();socket.destroy();}
    this.clients.clear();
    if(this.server?.listening)await new Promise(resolve=>this.server.close(resolve));
  }
}
