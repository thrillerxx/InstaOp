export const MEMPOOL_PREVIEW = "https://mempool.space/render/en/preview/tx";
const TX_RE = /^[0-9a-f]{64}$/i;
const MAX_BYTES = 2_000_000;

export function previewUrl(txid) {
  const id = String(txid || "").toLowerCase();
  if (!TX_RE.test(id)) throw Object.assign(new Error("Need a confirmed txid for a mempool preview."), { status: 400 });
  return `${MEMPOOL_PREVIEW}/${id}`;
}

export function squareMempoolSvg(png) {
  if (!png?.length) throw new Error("mempool preview was empty");
  const b64 = Buffer.from(png).toString("base64");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1080 1080" width="1080" height="1080">
  <rect width="1080" height="1080" fill="#0d1424"/>
  <image href="data:image/png;base64,${b64}" x="0" y="270" width="1080" height="540" preserveAspectRatio="xMidYMid meet"/>
</svg>
`;
}

export async function fetchMempoolPreview(txid, fetchImpl = fetch) {
  const url = previewUrl(txid);
  const res = await fetchImpl(url, {
    headers: { accept: "image/png,image/*", "user-agent": "InstaOp/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`mempool preview ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (type && !type.startsWith("image/")) throw new Error("mempool preview was not an image");
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("mempool preview size rejected");
  return bytes;
}
