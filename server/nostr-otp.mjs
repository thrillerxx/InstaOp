// Ported from livingry-ops/src/app/api/dashboard-auth/send/route.ts — Nostr OTP rail
// OPSEC: every send generates a fresh ephemeral keypair, signs exactly one NIP-04 DM, then discards it.
import { finalizeEvent, generateSecretKey, getPublicKey, nip04, nip19 } from "nostr-tools";
import { OTP_RECIPIENT_NPROFILE, DEFAULT_RELAYS } from "./nostr-config.mjs";
import { generateOtp } from "./otp-store.mjs";

async function ensureWebSocket() {
  if (typeof globalThis.WebSocket === "undefined") {
    const ws = await import("ws");
    globalThis.WebSocket = ws.default ?? ws.WebSocket;
  }
}

function operatorPubkey() {
  const d = nip19.decode(OTP_RECIPIENT_NPROFILE);
  if (d.type === "nprofile") return d.data.pubkey;
  if (d.type === "npub") return d.data;
  throw new Error("INSTAOP_OTP_NPROFILE must be nprofile or npub");
}
function hintRelays() {
  try { const d = nip19.decode(OTP_RECIPIENT_NPROFILE); if (d.type === "nprofile") return d.data.relays || []; } catch {}
  return [];
}

export async function sendNostrOtp({ npub, relayUrls: relayUrlsIn }) {
  await ensureWebSocket();
  const raw = String(npub || "").trim();
  if (!raw.startsWith("npub1")) return { ok: false, error: "A valid npub (npub1…) is required." };
  let recipientPubkey;
  try { const dec = nip19.decode(raw); if (dec.type !== "npub") return { ok: false, error: "Invalid npub." }; recipientPubkey = dec.data; } catch { return { ok: false, error: "Invalid npub." }; }

  const allowedExtra = (process.env.INSTAOP_OTP_ALLOWED_NPUBS || "").split(",").map(s=>s.trim()).filter(Boolean).map(n=>{ try{ const d=nip19.decode(n); return d.type==="npub"?d.data:null;}catch{return null;}}).filter(Boolean);
  const op = operatorPubkey();
  const allowed = new Set([op, ...allowedExtra]);
  if (!allowed.has(recipientPubkey)) return { ok: false, status: 404, error: "No Nostr identity matches that npub. Ask an operator to add it to the allow-list (INSTAOP_OTP_ALLOWED_NPUBS)." };

  const relayUrls = relayUrlsIn && relayUrlsIn.length ? relayUrlsIn : [...new Set([...DEFAULT_RELAYS.map(r=>r.url), ...hintRelays()])];
  const senderSk = generateSecretKey();
  const sessionKey = `nostr:${crypto.randomUUID()}`;
  const code = generateOtp(sessionKey);
  const plaintext = `InstaOp login code: ${code}\n\nThis code expires in 5 minutes. It was sent as a NIP-04 encrypted DM from an ephemeral key.`;
  const ciphertext = await nip04.encrypt(senderSk, recipientPubkey, plaintext);
  const event = finalizeEvent({ kind: 4, created_at: Math.floor(Date.now()/1000), tags: [["p", recipientPubkey]], content: ciphertext }, senderSk);
  try { senderSk.fill(0); } catch {}

  let pool;
  try { const { SimplePool } = await import("nostr-tools/pool"); pool = new SimplePool(); } catch { const nt = await import("nostr-tools"); pool = new nt.SimplePool(); }
  const relaysAttempted = relayUrls;
  const relaysSucceeded = [];
  try {
    const pubs = await Promise.allSettled(relaysAttempted.map(url => pool.publish([url], event)));
    pubs.forEach((r,i)=>{ if(r.status==="fulfilled") relaysSucceeded.push(relaysAttempted[i]); });
  } catch {
    for (const url of relaysAttempted) { try { const { Relay } = await import("nostr-tools/relay"); const relay = await Relay.connect(url); await relay.publish(event); relaysSucceeded.push(url); relay.close(); } catch {} }
  }
  try { pool.close(relaysAttempted); } catch {}
  if (!relaysSucceeded.length) return { ok: false, status: 502, error: `Failed to publish to any relay (${relaysAttempted.join(", ")}). Try again.` };
  return { ok: true, sessionKey, relaysAttempted, relaysSucceeded };
}
