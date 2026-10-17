import { createInterface, clearLine, cursorTo } from 'node:readline';
import { ControlClient } from '../src/control-client.js';
import { safeConsoleText } from '../src/chat.js';

const args=process.argv.slice(2);
const client=new ControlClient();let rl, stopped=false;
const write=line=>{
  if(process.stdout.writableLength>262144){client.close();return;}
  if(rl&&process.stdout.isTTY){clearLine(process.stdout,0);cursorTo(process.stdout,0);}
  process.stdout.write(safeConsoleText(line)+'\n');
  rl?.prompt(true);
};
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopped=true;rl?.close();client.close();});
try {
  if(args[0]==='--help'&&args.length===1)console.log('Usage: ./control.sh [--command "text or :command"]\nInteractive: :quit / Ctrl+C detaches without stopping the bot.\nSocket: MC_CONTROL_SOCKET or /run/mcskill-afk/control.sock');
  else {
    if(args.length!==0&&(args.length!==2||args[0]!=='--command'))throw new Error('CONTROL_ARGUMENTS');
    const single=args.length===2;
    if(!single&&(!process.stdin.isTTY||!process.stdout.isTTY))throw new Error('CONTROL_TTY_REQUIRED');
    client.on('output',write);
    await client.connect(process.env.MC_CONTROL_SOCKET||'/run/mcskill-afk/control.sock');
    if(single){process.exitCode=await client.command(args[1])?0:1;client.close();}
    else {
      rl=createInterface({input:process.stdin,output:process.stdout,terminal:true,historySize:0,prompt:'control> '});
      let busy=false;
      rl.on('line',async line=>{
        if(!line.trim()){rl.prompt();return;}
        if(busy){write('Предыдущая команда ещё выполняется.');return;}
        busy=true;
        try { await client.command(line); }
        catch { write('Команда не подтверждена. Автоматическая повторная отправка не выполняется.'); }
        finally { busy=false;if(!stopped)rl?.prompt(); }
      });
      rl.on('SIGINT',()=>{stopped=true;rl.close();client.close();});
      rl.on('close',()=>client.close());
      if(client.connected)await new Promise(resolve=>{client.once('closed',resolve);rl.prompt();});
      rl.close();
    }
  }
} catch(e) {
  if(!stopped){
    console.error(e.message==='CONTROL_ARGUMENTS'?'Используйте ./control.sh или ./control.sh --command "текст".':
      'Не удалось выполнить команду. Проверьте сервис и доступ к сокету; попробуйте sudo bash control.sh. Логин и пароль здесь не нужны.');
    process.exitCode=1;
  }
} finally { if(!rl)client.close(); }
