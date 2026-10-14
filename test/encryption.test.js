import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { aes, signedHex, serverHash, encryptionResponse } from '../src/encryption.js';
import { Reader } from '../src/codec.js';
test('Minecraft signed SHA1 reference vectors', () => {
  for (const [s,expected] of [['Notch','4ed1f46bbe04bc756bcb17c0c7ce3e4632f06a48'],['jeb_','-7c9d5b0044c130109a5d7b5fb5c317c02b4e28c1'],['simon','88e16a1019277b15d58faf0541e11910eb756f6']]) assert.equal(signedHex(createHash('sha1').update(s).digest()),expected);
  assert.equal(signedHex(Buffer.from([0,0,1])), '1'); assert.equal(signedHex(Buffer.from([0])), '0');
  assert.equal(serverHash('Notch',Buffer.alloc(0),Buffer.alloc(0)), '4ed1f46bbe04bc756bcb17c0c7ce3e4632f06a48');
});
test('RSA PKCS1 v1.5 response contains original secret and verification token', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa',{modulusLength:1024});
  const der = publicKey.export({format:'der',type:'spki'}), secret = Buffer.alloc(16,0x45), token=Buffer.from('abcd');
  const result = encryptionResponse(der,token,secret), r = new Reader(result.body);
  // Decode padding manually: modern OpenSSL intentionally disallows private PKCS1 decryption.
  function decrypt(b) { const p = privateDecrypt({key:privateKey,padding:constants.RSA_NO_PADDING},b); assert.equal(p[0],0); assert.equal(p[1],2); const end=p.indexOf(0,2); assert.ok(end>=10); return p.subarray(end+1); }
  assert.deepEqual(decrypt(r.shortBytes()),secret); assert.deepEqual(decrypt(r.shortBytes()),token); r.end();
});
test('AES-128-CFB8 known vector and streaming continuity', () => {
  // NIST SP800-38A F.3.7 (explicit key and IV).
  const { createCipheriv } = __crypto;
  const c=createCipheriv('aes-128-cfb8',Buffer.from('2b7e151628aed2a6abf7158809cf4f3c','hex'),Buffer.from('000102030405060708090a0b0c0d0e0f','hex'));
  assert.equal(c.update(Buffer.from('6bc1bee22e409f96e93d7e117393172a','hex')).toString('hex'),'3b79424c9c0dd436bace9e0ed4586a4f');
  const key=Buffer.alloc(16,7), a=aes(key), b=aes(key), data=Buffer.alloc(1000,29);
  const encrypted=Buffer.concat([a.encrypt.update(data.subarray(0,17)),a.encrypt.update(data.subarray(17))]);
  const out=[]; for(const x of encrypted)out.push(b.decrypt.update(Buffer.from([x])));
  assert.deepEqual(Buffer.concat(out),data);
});
import * as __crypto from 'node:crypto';
