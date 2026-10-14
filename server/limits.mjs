export const HARD_MAX = 90_000;
export const ADVERTISED_MAX = 99_000;
export const STANDARD_MAX = 80;
export const ORIGINAL_UPLOAD_MAX = 8_000_000;
export const BASE_TX_VBYTES = 125;
export const APP_FEE_SATS = 1337;

export function utf8Bytes(text) {
  return Buffer.byteLength(String(text || ""), "utf8");
}

export function formatBytes(n) {
  const value = Number(n) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

export function estimateSats(byteCount, { feeRate = 5, noTwitter = false } = {}) {
  const n = Number(byteCount) || 0;
  if (n < 1) return { ok: false, error: "Nothing to publish yet." };
  if (n > HARD_MAX) {
    return {
      ok: false,
      error: `Payload is ${n} bytes. OP_RETURN Bot invoices reject anything over ${HARD_MAX.toLocaleString()} bytes.`,
      byteCount: n,
      hardMax: HARD_MAX,
    };
  }
  const startRate = n > STANDARD_MAX ? Math.max(Number(feeRate) * 2, 5) : Number(feeRate) + 4;
  const sats = startRate * 2 * (BASE_TX_VBYTES + n) + APP_FEE_SATS + (noTwitter ? 1000 : 0) + (n > STANDARD_MAX ? 1000 : 0);
  return {
    ok: true,
    estimate: true,
    sats,
    byteCount: n,
    vbytes: BASE_TX_VBYTES + n,
    feeRateUsed: startRate,
    mempoolRate: Number(feeRate),
    noTwitter: Boolean(noTwitter),
    standard: n <= STANDARD_MAX,
    hardMax: HARD_MAX,
    advertisedMax: ADVERTISED_MAX,
    note: "Estimate from OP_RETURN Bot's published fee formula and a public mempool rate. The Lightning invoice in Phase 3 is the real price.",
  };
}

let cachedRate = { value: 5, at: 0 };

export async function mempoolFastestRate() {
  if (Date.now() - cachedRate.at < 30_000) return cachedRate.value;
  try {
    const res = await fetch("https://mempool.space/api/v1/fees/recommended", {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return cachedRate.value;
    const json = await res.json();
    const rate = Number(json.fastestFee || json.hourFee || 5);
    if (rate > 0) cachedRate = { value: rate, at: Date.now() };
  } catch {
    // keep last
  }
  return cachedRate.value;
}

export function publishLimits() {
  return {
    hardMax: HARD_MAX,
    advertisedMax: ADVERTISED_MAX,
    standardMax: STANDARD_MAX,
    originalUploadMax: ORIGINAL_UPLOAD_MAX,
    paymentsEnabled: process.env.INSTAOP_PAYMENTS === "1",
    unit: "bytes",
    text: "UTF-8 byte count. Emoji and other symbols may use more than one byte.",
    image: "The exact optimized image bytes are what would be written onchain. Not a hash.",
  };
}
