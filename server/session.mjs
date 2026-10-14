// Ported from livingry-ops/src/lib/session.ts (SEC-2026-001 remediation)
// Cookie = <random 32B hex>.<expiry ms>.<HMAC-SHA256 hex over "token.expiry">
// Signing key is per-process (restarts invalidate sessions — documented). HMAC + timingSafeEqual + expiry enforced.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_MAX_AGE_SECONDS = SESSION_MAX_AGE_MS / 1000;

const signingKey = randomBytes(32);
const store = new Map(); // token -> { tenantId, expiresAt }

function sign(token, expiry) {
  return createHmac("sha256", signingKey).update(`${token}.${expiry}`).digest("hex");
}

export function createSession(tenantId) {
  const token = randomBytes(32).toString("hex");
  const expiry = Date.now() + SESSION_MAX_AGE_MS;
  const sig = sign(token, expiry);
  const cookieValue = `${token}.${expiry}.${sig}`;
  store.set(token, { tenantId: tenantId ?? null, expiresAt: expiry });
  return { token, expiry, cookieValue, tenantId };
}

export function verifySession(cookieValue) {
  if (!cookieValue || typeof cookieValue !== "string") return null;
  const parts = cookieValue.split(".");
  if (parts.length !== 3) return null;
  const [token, expiryStr, sig] = parts;
  const expiry = Number(expiryStr);
  if (!expiry || Date.now() > expiry) { store.delete(token); return null; }
  const expected = sign(token, expiry);
  if (sig.length !== expected.length) return null;
  let ok = false;
  try { ok = timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8")); } catch { return null; }
  if (!ok) return null;
  const rec = store.get(token);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) { store.delete(token); return null; }
  return rec;
}

export function destroySession(cookieValue) {
  if (!cookieValue) return;
  const token = String(cookieValue).split(".")[0];
  if (token) store.delete(token);
}

export function setSessionTenant(cookieValue, tenantId) {
  const rec = verifySession(cookieValue);
  if (!rec) return null;
  rec.tenantId = tenantId;
  return rec;
}

export function parseCookie(header, name) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}
