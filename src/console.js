import { createInterface, clearLine, cursorTo } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { safeConsoleText } from './chat.js';
const errors = {
  NOT_IN_WORLD:'Сейчас нет подключения к миру. Дождитесь world_ready.',
  CHAT_INVALID:'Сообщение должно содержать от 1 до 100 символов, без управляющих кодов.',
  CHAT_RATE_LIMIT:'Подождите секунду перед следующим сообщением.',
  INVENTORY_NOT_READY:'Нет полного снимка инвентаря из 45 слотов. Дождитесь синхронизации или переподключитесь.',
  INVENTORY_LAYOUT_UNSUPPORTED:'Сервер прислал неподдерживаемую схему инвентаря.',
  WINDOW_OPEN:'Открыто другое окно. Сброс инвентаря остановлен.',
  CURSOR_NOT_EMPTY:'На курсоре находится предмет. Сброс не выполняется.',
  DROP_BUSY:'Сброс уже выполняется. :cancel — остановить оставшиеся действия.',
  INVENTORY_CHANGED:'Инвентарь изменился. Оставшиеся действия отменены; запросите новое подтверждение.',
  DROP_REJECTED:'Сервер отклонил выбрасывание. Оставшиеся действия отменены.',
  DROP_TIMEOUT:'Нет подтверждения выбрасывания от сервера. Оставшиеся действия отменены.',
  DROP_CANCELLED:'Оставшиеся действия сброса отменены.',
  CONFIRM_INVALID:'Нет действующего подтверждения с таким кодом. Используйте :dropall заново.'
};
export class ConsoleController {
  constructor({log,stop,input=process.stdin,output=process.stdout,chatEnabled=process.env.MC_CHAT!=='0'}) {
    Object.assign(this,{log,stop,input,output,chatEnabled});this.previousWrite=log.write;
    this.handlers={chat:text=>{if(this.chatEnabled)this.writeLine(`[CHAT] ${safeConsoleText(text)}`)},
      ready:()=>this.writeLine('Бот в мире. Текст или /команда → Enter; :help — локальные команды.'),
      ended:()=>this.setConnection(null),inventory_status:status=>this.inventoryStatus(status)};
    log.write=line=>this.writeLine(line);
    if(input.isTTY&&output.isTTY){
      this.rl=createInterface({input,output,terminal:true,historySize:0,prompt:'> '});
      this.rl.on('line',line=>{this.handleLine(line);this.rl?.prompt()});
      this.rl.on('SIGINT',()=>stop.abort());this.rl.prompt();
    }
  }
  writeLine(line) {
    if(this.closed||this.output.destroyed)return;
    // Never accumulate an unbounded chat/log queue if stdout or a pipe is slow.
    if(this.output.writableLength>262144){this.skipped=(this.skipped||0)+1;return;}
    if(this.rl){clearLine(this.output,0);cursorTo(this.output,0);}
    if(this.skipped){this.output.write(`[console] Пропущено строк при медленном выводе: ${this.skipped}\n`);this.skipped=0;}
    this.output.write(line+'\n');if(this.rl)this.rl.prompt(true);
  }
  setConnection(connection) {
    if(this.connection)for(const [event,fn] of Object.entries(this.handlers))this.connection.off(event,fn);
    this.confirmation=null;this.connection=connection;
    if(connection)for(const [event,fn] of Object.entries(this.handlers))connection.on(event,fn);
  }
  inventory() {
    const c=this.connection;
    if(!c?.ready||c.closed||!c.game?.position||!c.forge?.done)throw new Error('NOT_IN_WORLD');
    return c.game.inventory;
  }
  showSlots(plan) {
    if(!plan.slots.length){this.writeLine('Обычный инвентарь, хотбар, броня и сетка крафта пусты.');return;}
    for(const value of plan.slots){
      const area=value.slot<=4?'крафт':value.slot<=8?'броня':value.slot>=36?'хотбар':'инвентарь';
      this.writeLine(`Слот ${value.slot} (${area}): id=${value.id}, damage=${value.damage}, количество=${value.count}`);
    }
  }
  handleLine(raw) {
    const line=raw.trim();if(!line)return;
    try {
      if(line===':help'){
        this.writeLine('Текст или /команда → серверный чат (до 100 символов, не чаще раза в секунду).');
        this.writeLine(':inventory — слоты; :dropall — подготовить сброс; :confirm КОД — подтвердить; :cancel — отменить; :quit — выйти.');
      } else if(line===':quit'){this.stop.abort();}
      else if(line===':cancel'){
        this.confirmation=null;this.connection?.game?.inventory.cancel();
        this.writeLine('Подтверждение и оставшиеся действия отменены. Уже отправленный сброс отменить нельзя.');
      } else if(line===':inventory')this.showSlots(this.inventory().snapshot());
      else if(line===':dropall'){
        const plan=this.inventory().snapshot();this.confirmation=null;this.showSlots(plan);
        if(!plan.slots.length)return;
        const code=randomBytes(3).toString('hex').toUpperCase();
        this.confirmation={code,plan,expires:Date.now()+30000};
        this.writeLine(`Будут выброшены ${plan.slots.length} стаков из перечисленных слотов, ВКЛЮЧАЯ БРОНЮ и сетку крафта.`);
        this.writeLine('Вещи упадут рядом; их могут подобрать другие игроки. Сброс нельзя отменить после отправки.');
        this.writeLine(`Для подтверждения в течение 30 секунд введите :confirm ${code}. :cancel — отмена.`);
      } else if(line.startsWith(':confirm ')){
        const pending=this.confirmation;
        if(!pending||Date.now()>pending.expires||line.slice(9).trim()!==pending.code)throw new Error('CONFIRM_INVALID');
        this.confirmation=null;this.inventory().startDrop(pending.plan);
      } else if(line.startsWith(':'))this.writeLine('Неизвестная локальная команда. :help — справка.');
      else {
        if(!this.connection)throw new Error('NOT_IN_WORLD');
        this.connection.sendChat(line);
      }
    } catch(e){this.writeLine(errors[e.message]||'Действие не выполнено. Подключение и инвентарь проверьте через :help.');}
  }
  inventoryStatus({code,count}) {
    if(code==='DROP_STARTED')this.writeLine(`Начат подтверждённый сброс ${count} стаков, по одному с ожиданием сервера.`);
    else if(code==='DROP_COMPLETE'){
      this.writeLine(`Подтверждён сброс ${count} стаков. Модовые слоты и содержимое рюкзаков не затрагивались.`);
      const remaining=this.connection?.game?.inventory.slots.slice(1).filter(Boolean).length||0;
      if(remaining)this.writeLine(`В инвентаре осталось/появилось ${remaining} непустых слотов. Автоматический повтор не выполняется.`);
    } else this.writeLine(`${errors[code]||'Сброс остановлен.'} Подтверждено стаков: ${count}. Уже отправленное действие могло выполниться.`);
  }
  close() {
    this.setConnection(null);this.rl?.close();this.rl=null;this.log.write=this.previousWrite;this.closed=true;
  }
}
