import { createHash, randomBytes, publicEncrypt, createPublicKey, constants, createCipheriv, createDecipheriv } from 'node:crypto';
import { concat, shortBuffer } from './codec.js';
export function signedHex(digest) {
  const negative = (digest[0] & 128) !== 0;
  let n = BigInt('0x' + digest.toString('hex'));
  if (negative) n -= 1n << BigInt(digest.length * 8);
  return n.toString(16);
}
export function serverHash(serverId, secret, publicKey) {
  return signedHex(createHash('sha1').update(Buffer.from(serverId, 'latin1')).update(secret).update(publicKey).digest());
}
export function encryptionResponse(publicKey, verifyToken, secret = randomBytes(16)) {
  const key = createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 1024 || key.asymmetricKeyDetails.modulusLength > 4096) throw new Error('Unsupported server RSA key');
  const encrypt = b => publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, b);
  return { secret, body: concat(shortBuffer(encrypt(secret)), shortBuffer(encrypt(verifyToken))) };
}
export function aes(secret) {
  return { encrypt: createCipheriv('aes-128-cfb8', secret, secret), decrypt: createDecipheriv('aes-128-cfb8', secret, secret) };
}
