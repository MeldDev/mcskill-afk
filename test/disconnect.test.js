import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disconnectCode } from '../src/disconnect.js';
test('server restarts and maintenance are retryable across chat component formats',()=>{
 for(const reason of ['Server restarting', '§cПерезапуск сервера!','Технические работы',JSON.stringify({text:'',extra:[{text:'Сервер '},{text:'перезагружается'}]}),JSON.stringify({translate:'multiplayer.disconnect.server_shutdown'})])assert.equal(disconnectCode(reason),'SERVER_RESTART');
 for(const reason of ['Server is full','Сервер временно недоступен','Could not connect to default or fallback server'])assert.equal(disconnectCode(reason),'SERVER_UNAVAILABLE');
});
test('AFK, account rejection, ban and unknown kicks do not trigger retry loops',()=>{
 for(const reason of ['Kicked for AFK before restart','Вы забанены. Дождитесь рестарта','Invalid session; server restarting',JSON.stringify({text:'FAKE_TEST_TOKEN'}),'Disconnected','Whitelist: maintenance'])assert.equal(disconnectCode(reason),'SERVER_DISCONNECT');
});
