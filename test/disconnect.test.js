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
test('generic login refusals retry during backend startup without requiring a known phrase',()=>{
 for(const raw of ['Disconnected','Backend is still booting',JSON.stringify({translate:'disconnect.genericReason',with:['Please wait']}),'']){
  assert.equal(disconnectCode(raw,'LOGIN'),'SERVER_LOGIN_RETRY');
  assert.equal(disconnectCode(raw,'PLAY'),'SERVER_DISCONNECT');
 }
});
test('explicit account/protection rejections remain terminal even during login',()=>{
 for(const raw of ['Invalid session','InvalidSession','Failed to verify username!','Authentication failed','You are banned','AFK kick','Whitelist','Invalid hostname','Outdated client','Captcha required','Вы уже в игре','Сессия истекла','Неверный пароль','Invalid credentials','MFA confirmation required','Новое устройство','Invalid session; authentication servers are down'])assert.equal(disconnectCode(raw,'LOGIN'),'SERVER_DISCONNECT',raw);
 for(const raw of ['Authentication servers are down','multiplayer.disconnect.authservers_down','Авторизация временно недоступна','Временная ошибка авторизации, попробуйте позже'])assert.equal(disconnectCode(raw,'LOGIN'),'SERVER_UNAVAILABLE');
});
