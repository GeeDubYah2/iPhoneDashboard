// Web Push using only Node's built-in crypto (no extra packages).
// Implements VAPID (RFC 8292) and message encryption "aes128gcm" (RFC 8291).

import {
  createCipheriv, createDecipheriv, createECDH, createHmac, createPrivateKey,
  generateKeyPairSync, randomBytes, sign,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(s, "base64url");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const label = (s) => Buffer.from(s, "latin1");

// The helper's own VAPID key pair, created on first run and kept in a git-ignored file.
export function loadVapid(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { /* first run */ }
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const vapid = {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
  };
  writeFileSync(file, JSON.stringify(vapid));
  return vapid;
}

function vapidJwt(vapid, audience, subject) {
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const data = `${header}.${claims}`;
  const sig = sign("sha256", Buffer.from(data), { key: createPrivateKey(vapid.privateKeyPem), dsaEncoding: "ieee-p1363" });
  return `${data}.${b64u(sig)}`;
}

// Derives the content key and nonce shared with the browser (RFC 8291 section 3).
function deriveKeys(authSecret, shared, uaPublic, asPublic, salt) {
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([label("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([label("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([label("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
  return { cek, nonce };
}

export function encrypt(subscription, plaintext) {
  const uaPublic = fromB64u(subscription.keys.p256dh);
  const authSecret = fromB64u(subscription.keys.auth);
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = randomBytes(16);
  const { cek, nonce } = deriveKeys(authSecret, ecdh.computeSecret(uaPublic), uaPublic, asPublic, salt);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const record = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(plaintext, "utf8"), Buffer.from([2])])), // 0x02 marks the last record
    cipher.final(), cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16); // record size
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, record]);
}

// Used only by the self-test: what a browser does to read a message.
export function decryptForTest(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const idLen = body[20];
  const asPublic = body.subarray(21, 21 + idLen);
  const data = body.subarray(21 + idLen);
  const { cek, nonce } = deriveKeys(authSecret, uaEcdh.computeSecret(asPublic), uaEcdh.getPublicKey(), asPublic, salt);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString("utf8");
}

// Sends one notification. Returns the push service's HTTP status (201 = accepted).
export async function sendPush(vapid, subscription, payload, subject) {
  const endpoint = new URL(subscription.endpoint);
  if (endpoint.protocol !== "https:") throw new Error("push endpoint must be https");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "900",
      Urgency: "high",
      Authorization: `vapid t=${vapidJwt(vapid, endpoint.origin, subject)}, k=${vapid.publicKey}`,
    },
    body: encrypt(subscription, JSON.stringify(payload)),
    signal: AbortSignal.timeout(15000),
  });
  return { status: res.status, detail: res.ok ? "" : (await res.text().catch(() => "")).slice(0, 200) };
}
