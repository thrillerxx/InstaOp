// Ported from livingry-ops/src/lib/otp-store.ts (CSPRNG, no Math.random)
// OTP TTL 5 min, 5 attempts, in-memory Map (per-process, same contract as source).
import { randomInt } from "node:crypto";

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const store = new Map();

export function generateOtp(sessionKey) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const now = Date.now();
  store.set(sessionKey, { code, createdAt: now, expiresAt: now + OTP_TTL_MS, attempts: 0 });
  return code;
}

export function verifyOtp(sessionKey, candidate) {
  const rec = store.get(sessionKey);
  if (!rec) return { ok: false, reason: "No OTP requested for this session." };
  if (Date.now() > rec.expiresAt) { store.delete(sessionKey); return { ok: false, reason: "Code expired. Request a new one." }; }
  if (rec.attempts >= MAX_ATTEMPTS) { store.delete(sessionKey); return { ok: false, reason: "Too many attempts. Request a new code." }; }
  rec.attempts += 1;
  if (rec.code !== String(candidate).trim()) return { ok: false, reason: "Incorrect code." };
  store.delete(sessionKey);
  return { ok: true };
}

// test helper
export function _clearOtpStore() { store.clear(); }
