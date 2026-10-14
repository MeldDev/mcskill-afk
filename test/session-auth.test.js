import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { McSkillSessionService } from '../src/auth.js';
import { config, sessionProvider } from '../src/config.js';
import { extract } from '../tools/import-session.js';
const fake={username:'Test',uuid:'00000000000000000000000000000001',accessToken:'FAKE_TOKEN'};
function requestMock(status,body,inspect=()=>{}){
  return (url,options,callback)=>{
    const req=new EventEmitter();req.destroy=()=>req.emit('error',new Error('test'));
    req.end=data=>{inspect(url,options,JSON.parse(data));queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=status;res.destroy=e=>res.emit('error',e);callback(res);res.emit('data',Buffer.from(body));res.emit('end')})};return req;
  };
}
test('MCSkill join POST uses exact authlib fields and accepts empty 204',async()=>{
  await new McSkillSessionService(config({}),requestMock(204,'',(url,opt,body)=>{
    assert.equal(url.href,'https://auth.mcskill.ru/join1710');assert.equal(opt.method,'POST');assert.deepEqual(body,{accessToken:'FAKE_TOKEN',selectedProfile:fake.uuid,serverId:'-123'});
  })).join(fake,'-123');
});
test('legacy endpoint, JSON error on HTTP 200, redirects and outages',async()=>{
  await new McSkillSessionService(config({MCSKILL_AUTH_MODE:'legacy'}),requestMock(200,'{}',url=>assert.equal(url.pathname,'/joinserver1710.php'))).join(fake,'abc');
  for(const [status,body,retry] of [[200,'{"error":"ForbiddenOperationException","errorMessage":"FAKE_TOKEN"}',false],[403,'',false],[302,'',false],[503,'',true],[200,'invalid',true]]) {
    await assert.rejects(new McSkillSessionService(config({}),requestMock(status,body)).join(fake,'abc'),e=>e.retryable===retry&&!e.message.includes('FAKE_TOKEN'));
  }
  assert.throws(()=>config({MCSKILL_AUTH_ORIGIN:'https://example.com'}));
});
test('session environment normalizes UUID and validates credentials',async()=>{
  const s=await sessionProvider({}, {MC_ACCESS_TOKEN:fake.accessToken,MC_USERNAME:fake.username,MC_UUID:'00000000-0000-0000-0000-000000000001'});assert.deepEqual(s,fake);
  await assert.rejects(sessionProvider({}, {MC_ACCESS_TOKEN:'x',MC_USERNAME:'bad name',MC_UUID:fake.uuid}));
});
test('launcher importer extracts only session fields and handles quoted args',()=>{
  const s=extract('--username "Test"\n--uuid '+fake.uuid+'\n--accessToken "FAKE_TOKEN"\n--userProperties "{}"');assert.deepEqual(s,fake);assert.throws(()=>extract('--username "unterminated'));
});
