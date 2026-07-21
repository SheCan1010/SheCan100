const crypto = require("crypto");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(":");
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
}

// In-memory session store: sid -> { role: 'customer'|'freelancer'|'admin', id }
const sessions = new Map();

function createSession(role, id) {
  const sid = crypto.randomBytes(24).toString("hex");
  sessions.set(sid, { role, id });
  return sid;
}

function getSession(sid) {
  if (!sid) return null;
  return sessions.get(sid) || null;
}

function destroySession(sid) {
  sessions.delete(sid);
}

// In-memory password-reset tokens: token -> { role, id, expiresAt }
const resetTokens = new Map();
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function createResetToken(role, id) {
  const token = crypto.randomBytes(24).toString("hex");
  resetTokens.set(token, { role, id, expiresAt: Date.now() + RESET_TOKEN_TTL_MS });
  return token;
}

function consumeResetToken(token) {
  const entry = resetTokens.get(token);
  if (!entry) return null;
  resetTokens.delete(token);
  if (entry.expiresAt < Date.now()) return null;
  return { role: entry.role, id: entry.id };
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

module.exports = {
  hashPassword, verifyPassword, createSession, getSession, destroySession, parseCookies,
  createResetToken, consumeResetToken,
};
