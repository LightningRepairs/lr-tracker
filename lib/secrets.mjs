// Encrypts RepairShopr API keys before they're stored in the database (AES-256-GCM).
// The encryption key is derived from SESSION_SECRET — if you ever change SESSION_SECRET, saved
// API keys can't be read anymore and need to be entered again in the Admin Console.
import crypto from "node:crypto";

function aesKey() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("SESSION_SECRET is not set (needs 16+ random characters)");
  return crypto.createHash("sha256").update("lr-rs-api-keys:" + s).digest();
}
export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", aesKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b => b.toString("base64url")).join(".");
}
export function decryptSecret(enc) {
  if (!enc) return null;
  try {
    const [iv, tag, ct] = String(enc).split(".").map(x => Buffer.from(x, "base64url"));
    const d = crypto.createDecipheriv("aes-256-gcm", aesKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch { return null; }
}
export const last4 = k => String(k || "").slice(-4);
