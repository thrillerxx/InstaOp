import { HARD_MAX, utf8Bytes } from "./limits.mjs";

const FILLER = new Set([
  "just",
  "really",
  "very",
  "actually",
  "basically",
  "literally",
  "honestly",
  "maybe",
  "probably",
  "kinda",
  "kind",
  "sort",
  "of",
  "like",
  "that",
  "simply",
]);

const MIME = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export function sniffImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return MIME.jpeg;
  if (buffer[0] === 0x89 && buffer.toString("ascii", 1, 4) === "PNG") return MIME.png;
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return MIME.webp;
  return null;
}

export function suggestShorten(text) {
  const original = String(text || "");
  const originalBytes = utf8Bytes(original);
  let suggested = original.replace(/\s+/g, " ").trim();
  const changes = [];
  if (suggested !== original.trim() || /\s{2,}/.test(original)) {
    changes.push("Collapsed extra spaces and line breaks.");
  }
  const words = suggested.split(" ");
  const kept = [];
  for (let i = 0; i < words.length; i += 1) {
    const raw = words[i];
    const lower = raw.toLowerCase().replace(/[^a-z']/g, "");
    if (FILLER.has(lower) && words.length - kept.length > 3) {
      changes.push(`Dropped filler “${raw}”.`);
      continue;
    }
    kept.push(raw);
  }
  suggested = kept.join(" ");
  if (utf8Bytes(suggested) > HARD_MAX) {
    let cut = suggested;
    while (utf8Bytes(cut) > HARD_MAX && cut.length) cut = cut.slice(0, -8).trim();
    if (cut !== suggested) {
      changes.push("Trimmed the end so the statement fits the 90,000 byte invoice limit.");
      suggested = cut;
    }
  }
  const suggestedBytes = utf8Bytes(suggested);
  return {
    original,
    suggested,
    originalBytes,
    suggestedBytes,
    savings: Math.max(0, originalBytes - suggestedBytes),
    overLimit: originalBytes > HARD_MAX,
    fits: suggestedBytes > 0 && suggestedBytes <= HARD_MAX,
    applied: false,
    changes: [...new Set(changes)],
    note: "This is a suggestion only. The original statement stays until you accept it.",
  };
}

export function buildPayload({ statement = "", image = null }) {
  const text = String(statement || "");
  if (image?.bytes?.length && text) {
    const t = Buffer.from(text, "utf8");
    const header = Buffer.from(`IO1\nT ${t.length}\n`);
    const mid = Buffer.from(`I ${image.mime} ${image.bytes.length}\n`);
    return Buffer.concat([header, t, mid, image.bytes]);
  }
  if (image?.bytes?.length) return Buffer.from(image.bytes);
  return Buffer.from(text, "utf8");
}

export function parsePayload(buffer) {
  if (!buffer || !buffer.length) return { kind: "empty", statement: "", image: null };
  const start = buffer.subarray(0, 4).toString("utf8");
  if (start === "IO1\n") {
    const asText = buffer.toString("utf8");
    const tMatch = /^IO1\nT (\d+)\n/.exec(asText);
    if (tMatch) {
      const tLen = Number(tMatch[1]);
      const tStart = tMatch[0].length;
      const statement = buffer.subarray(tStart, tStart + tLen).toString("utf8");
      const rest = buffer.subarray(tStart + tLen);
      const iLine = rest.toString("utf8").split("\n", 1)[0] || "";
      const iMatch = /^I (\S+) (\d+)$/.exec(iLine);
      if (iMatch) {
        const mime = iMatch[1];
        const iLen = Number(iMatch[2]);
        const imgStart = Buffer.byteLength(iLine, "utf8") + 1;
        const bytes = rest.subarray(imgStart, imgStart + iLen);
        return { kind: "both", statement, image: { mime, bytes } };
      }
      return { kind: "text", statement, image: null };
    }
  }
  const mime = sniffImage(buffer);
  if (mime) return { kind: "image", statement: "", image: { mime, bytes: buffer } };
  return { kind: "text", statement: buffer.toString("utf8"), image: null };
}

export function validatePayload(buffer) {
  const n = buffer?.length || 0;
  if (!n) return { ok: false, error: "Add a statement or an image before you can publish." };
  if (n > HARD_MAX) {
    return {
      ok: false,
      error: `Ready payload is ${n} bytes. Shrink it under ${HARD_MAX.toLocaleString()} before it can leave the draft queue.`,
      byteCount: n,
    };
  }
  return { ok: true, byteCount: n };
}
