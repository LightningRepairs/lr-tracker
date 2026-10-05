// Stateless signed session tokens: base64url(payload).base64url(HMAC-SHA256(payload)).
import crypto from "node:crypto";

const TTL_SEC = 14 * 3600; // a long shift

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("SESSION_SECRET is not set (needs 16+ random characters)");
  return s;
}
const b64u = buf => Buffer.from(buf).toString("base64url");

export function signToken(personId) {
  const payload = b64u(JSON.stringify({ pid: personId, exp: Math.floor(Date.now() / 1000) + TTL_SEC }));
  const sig = b64u(crypto.createHmac("sha256", secret()).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = b64u(crypto.createHmac("sha256", secret()).update(payload).digest());
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.pid || data.exp < Date.now() / 1000) return null;
    return data.pid;
  } catch { return null; }
}
