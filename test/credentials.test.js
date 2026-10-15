import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, chmod, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireAccount, loadCredentials, saveCredentials, validateCredentials, credentialsPath } from '../src/credentials.js';
import { passwordConnector } from '../src/password-connection.js';
import { reconnect } from '../src/reconnect.js';
import { config } from '../src/config.js';
const account = { username:'FakeUser',password:'FAKE_TEST_PASSWORD',authOrigin:'https://auth.mcskill.ru' };
const session = { username:'FakeUser',accessToken:'FAKE_TEST_TOKEN' };
const log = {event(){}};

test('credentials round trip, atomic replacement, missing and malformed file', async () => {
  const dir = await mkdtemp(join(tmpdir(),'mcskill-credentials-test-')), path = join(dir,'private','credentials.json');
  try {
    assert.equal(await loadCredentials(path),null);
    await saveCredentials(account,path);
    assert.deepEqual(await loadCredentials(path),account);
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777,0o600);
    await saveCredentials({...account,password:'REPLACED_FAKE'},path);
    assert.equal((await loadCredentials(path)).password,'REPLACED_FAKE');
    await writeFile(path,'{"password":"FAKE_SECRET",');
    await assert.rejects(loadCredentials(path), e => e.code === 'CREDENTIALS_INVALID' && !e.message.includes('FAKE_SECRET'));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('Linux refuses readable-by-others credentials', {skip:process.platform === 'win32'}, async () => {
  const dir = await mkdtemp(join(tmpdir(),'mcskill-credentials-test-')), path=join(dir,'credentials.json');
  try { await saveCredentials(account,path); await chmod(path,0o644); await assert.rejects(loadCredentials(path),{code:'CREDENTIALS_INVALID'}); }
  finally { await rm(dir,{recursive:true,force:true}); }
});
test('Linux refuses credential symlinks', {skip:process.platform === 'win32'}, async () => {
  const dir = await mkdtemp(join(tmpdir(),'mcskill-credentials-test-')), path=join(dir,'credentials.json');
  try { await saveCredentials(account,path); await symlink(path,join(dir,'link.json')); await assert.rejects(loadCredentials(join(dir,'link.json')),{code:'CREDENTIALS_INVALID'}); }
  finally { await rm(dir,{recursive:true,force:true}); }
});
test('credential validation and default location exclude repository and unofficial origins', () => {
  assert.equal(credentialsPath({MC_CREDENTIALS_FILE:'/etc/mcskill-afk/credentials.json'}),'/etc/mcskill-afk/credentials.json');
  assert.ok(credentialsPath({}).includes('.config'));
  for (const change of [{password:''},{password:'a'.repeat(4097)},{authOrigin:'https://example.com'}])
    assert.throws(()=>validateCredentials({...account,...change}),{code:'CREDENTIALS_INVALID'});
});
test('saved account skips all prompts and service fails closed when no credentials', async () => {
  assert.deepEqual(await acquireAccount({load:async()=>account,prompt:()=>assert.fail('prompted'),login:()=>assert.fail('logged in')}),{credentials:account});
  await assert.rejects(acquireAccount({service:true,load:async()=>null,prompt:()=>assert.fail('prompted')}),{code:'CREDENTIALS_MISSING'});
});
test('Y saves only after accepted login, N does not save; password prompt is hidden', async () => {
  for (const answer of ['Y','y','yes','N','']) {
    const answers=[' FakeUser ',account.password,answer], prompts=[], saved=[];let accepted=false;
    const result=await acquireAccount({authOrigin:account.authOrigin,load:async()=>null,
      prompt:async (label,hidden)=>{prompts.push({label,hidden});return answers.shift()},
      login:async (...args)=>{assert.deepEqual(args.slice(0,3),Object.values(account));accepted=true;return session},
      save:async value=>{assert.ok(accepted);saved.push(value)} });
    assert.equal(prompts[1].hidden,true); assert.equal(prompts.length,3);
    assert.equal(saved.length,/^y(es)?$/i.test(answer)?1:0);assert.equal(result.initialSession,session);
  }
  const answers=['FakeUser',account.password,'Y'];
  await assert.rejects(acquireAccount({authOrigin:account.authOrigin,load:async()=>null,prompt:async()=>answers.shift(),
    login:async()=>{throw Object.assign(new Error('LOGIN_REJECTED'),{code:'LOGIN_REJECTED'})},save:()=>assert.fail('saved invalid credentials')}),{code:'LOGIN_REJECTED'});
});
test('password connection retries auth downtime and refreshes expired session once at minute intervals', async () => {
  let logins=0,connections=0;const delays=[];
  const connect=passwordConnector({credentials:account,signal:new AbortController().signal,log,
    login:async()=>{if(++logins===1)throw Object.assign(new Error('LOGIN_NETWORK'),{code:'LOGIN_NETWORK'});return session},
    connect:async()=>++connections===1?{error:{code:'AUTH_REJECTED',retryable:false}}:{ready:true} });
  assert.equal(await reconnect(config({}),connect,log,new AbortController().signal,async ms=>delays.push(ms)),0);
  assert.equal(logins,3);assert.deepEqual(delays,[60000,60000]);
});
test('rejected credentials, 2FA, bans and repeated rejected fresh session stop without loops', async () => {
  for(const code of ['LOGIN_REJECTED','LOGIN_MFA_REQUIRED','LOGIN_TOTP_REQUIRED']) {
    const connect=passwordConnector({credentials:account,log,login:async()=>{throw Object.assign(new Error(code),{code})}});
    assert.equal((await connect()).error.retryable,false);
  }
  let logins=0;
  const connect=passwordConnector({credentials:account,log,login:async()=>{logins++;return session},connect:async()=>({error:{code:'SERVER_SESSION_EXPIRED',retryable:false}})});
  assert.equal((await connect()).error.retryable,true);
  assert.equal((await connect()).error.retryable,false);assert.equal(logins,2);
  const banned=passwordConnector({credentials:account,initialSession:session,log,login:()=>assert.fail('unneeded login'),connect:async()=>({error:{code:'SERVER_DISCONNECT',retryable:false}})});
  assert.equal((await banned()).error.retryable,false);
});
