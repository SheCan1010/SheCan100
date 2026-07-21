// Zero-dependency Web Push (RFC 8291 message encryption + RFC 8292 VAPID auth), implemented
// with only Node's built-in `crypto` - no npm package needed, matching the rest of this app's
// zero-dependency philosophy. Verified byte-for-byte against the official RFC 8291 Appendix A
// test vector (aes128gcm ciphertext) and a self-checked VAPID JWT signature/verify round-trip.
//
// Usage:
//   const { generateVAPIDKeys, sendNotification } = require("./webpush");
//   await sendNotification(subscription, { title, body, url }, { subject, publicKey, privateKey });
//
// `subscription` is exactly what the browser's PushManager.subscribe() returns (JSON-able):
//   { endpoint, keys: { p256dh, auth } }

const crypto = require("crypto");
const https = require("https");
const { URL } = require("url");

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf.toString("base64url");
}
function fromB64url(str) {
  return Buffer.from(str, "base64url");
}

// Generates a fresh VAPID keypair (P-256), returned in the standard url-safe-base64 format
// used everywhere in the Web Push ecosystem (uncompressed EC point for the public key, raw
// 32-byte scalar for the private key) - set these once as Render env vars and never change
// them, since every stored push subscription is tied to this exact public key.
function generateVAPIDKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pubJwk = publicKey.export({ format: "jwk" });
  const privJwk = privateKey.export({ format: "jwk" });
  const x = fromB64url(pubJwk.x), y = fromB64url(pubJwk.y);
  const uncompressed = Buffer.concat([Buffer.from([0x04]), x, y]);
  return { publicKey: b64url(uncompressed), privateKey: b64url(fromB64url(privJwk.d)) };
}

// Reconstructs a signable EC private-key object from just the raw 32-byte scalar (that's all
// we store as VAPID_PRIVATE_KEY) - derives the matching public point via ECDH point
// multiplication, since a JWK private key needs x/y alongside d.
function privateKeyObjFromRaw(dBuf) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(dBuf);
  const pub = ecdh.getPublicKey();
  const x = pub.slice(1, 33), y = pub.slice(33, 65);
  return crypto.createPrivateKey({ key: { kty: "EC", crv: "P-256", x: b64url(x), y: b64url(y), d: b64url(dBuf) }, format: "jwk" });
}

// Builds the "Authorization: vapid t=<JWT>, k=<publicKey>" header value (RFC 8292) - proves to
// the push service (FCM/Mozilla/etc) that these notifications come from a consistent, known
// sender, without needing per-service API keys.
function buildVapidAuthHeader(pushEndpoint, subject, publicKeyB64, privateKeyB64) {
  const audience = new URL(pushEndpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const payload = { aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const keyObj = privateKeyObjFromRaw(fromB64url(privateKeyB64));
  const sig = crypto.sign("sha256", Buffer.from(signingInput), { key: keyObj, dsaEncoding: "ieee-p1363" });
  const jwt = `${signingInput}.${b64url(sig)}`;
  return `vapid t=${jwt}, k=${publicKeyB64}`;
}

// One-block HKDF-Expand (RFC 5869) - every derivation in RFC 8291 needs 32 bytes or fewer, so
// a single HMAC block (with the standard 0x01 counter byte) is always enough; a general
// multi-block HKDF isn't needed here.
function hkdfExpandOneBlock(prk, info, len) {
  return crypto.createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([0x01])])).digest().slice(0, len);
}

// Encrypts a payload per RFC 8291 ("Content-Encoding: aes128gcm") for a single-record message
// (our push payloads are always small, well under the 4096-byte record size) - see webpush.js
// header comment for the verification this was checked against.
function encryptPayload(subscription, plaintextBuf, vapidPublicKeyB64) {
  const receiverPublic = fromB64url(subscription.keys.p256dh);
  const authSecret = fromB64url(subscription.keys.auth);
  const salt = crypto.randomBytes(16);

  // Fresh ephemeral keypair per message (NOT the VAPID identity keypair - this one is only
  // used for the ECDH step of message encryption, as required by RFC 8291).
  const senderEcdh = crypto.createECDH("prime256v1");
  senderEcdh.generateKeys();
  const asPublic = senderEcdh.getPublicKey();
  const sharedSecret = senderEcdh.computeSecret(receiverPublic);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), receiverPublic, asPublic]);
  const prkKey = crypto.createHmac("sha256", authSecret).update(sharedSecret).digest();
  const ikm = hkdfExpandOneBlock(prkKey, keyInfo, 32);

  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  const cek = hkdfExpandOneBlock(prk, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16);
  const nonce = hkdfExpandOneBlock(prk, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12);

  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const padded = Buffer.concat([plaintextBuf, Buffer.from([0x02])]); // 0x02 = final (and only) record
  const enc = Buffer.concat([cipher.update(padded), cipher.final()]);
  const ciphertext = Buffer.concat([enc, cipher.getAuthTag()]);

  const recordSize = 4096;
  const rsBuf = Buffer.alloc(4);
  rsBuf.writeUInt32BE(recordSize, 0);
  const header = Buffer.concat([salt, rsBuf, Buffer.from([asPublic.length]), asPublic]);
  return Buffer.concat([header, ciphertext]);
}

// Sends one push message to one subscription. Resolves on success (push service accepted it,
// HTTP 2xx/201). Rejects with an Error carrying `.statusCode` on failure - callers should treat
// 404/410 as "this subscription is gone, stop using it" (the browser unsubscribed or the
// endpoint expired), matching the standard web-push library's convention so calling code can
// prune dead subscriptions the same way regardless of which implementation sent the message.
function sendNotification(subscription, payloadObj, { subject, publicKey, privateKey, ttl = 86400 } = {}) {
  return new Promise((resolve, reject) => {
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return reject(new Error("Invalid push subscription"));
    }
    if (!publicKey || !privateKey) return reject(new Error("VAPID keys not configured"));
    let body;
    try {
      const plaintext = Buffer.from(JSON.stringify(payloadObj), "utf8");
      body = encryptPayload(subscription, plaintext, publicKey);
    } catch (e) {
      return reject(e);
    }
    const authHeader = buildVapidAuthHeader(subscription.endpoint, subject, publicKey, privateKey);
    const url = new URL(subscription.endpoint);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      port: url.port || 443,
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        "Content-Length": body.length,
        TTL: String(ttl),
        Authorization: authHeader,
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ statusCode: res.statusCode });
        const err = new Error(`Push service responded ${res.statusCode}: ${data}`);
        err.statusCode = res.statusCode;
        reject(err);
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = { generateVAPIDKeys, sendNotification };
