import { writeFileSync } from "node:fs";
import { classifyArt, hashSeed } from "./captions.mjs";

function rng(seed) {
  let t = seed || 1;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const PALETTES = {
  romance: ["#1b0614", "#7a1848", "#e36aa5", "#f6d0c8", "#fff4ea"],
  cinematic: ["#070b14", "#16324f", "#c9842a", "#f2d6a2", "#f7f1e3"],
  freedom: ["#08131f", "#1d4e6b", "#e07a2f", "#f3c37a", "#f8efe2"],
  lightning: ["#05060d", "#141b3a", "#3d6bff", "#8be7ff", "#f4fbff"],
  rust: ["#140b07", "#4a1d0c", "#c25a1a", "#d7a15a", "#1f4d4a"],
  data: ["#06110d", "#0b2a1c", "#39d98a", "#d6ff7f", "#e8ffe8"],
  playful: ["#12081c", "#6d28d9", "#f43f5e", "#fbbf24", "#38bdf8"],
  bitcoin: ["#140d06", "#3d2208", "#f7931a", "#ffd199", "#fff6e8"],
  celebration: ["#1a0c08", "#7c2d12", "#f59e0b", "#fde68a", "#fff7ed"],
  type: ["#0a0a0a", "#1f1f1f", "#f5f5f5", "#f97316", "#a3a3a3"],
  surreal: ["#0b1020", "#312e81", "#db2777", "#22d3ee", "#fde68a"],
};

export function renderArtwork(post, dest) {
  const seed = hashSeed(`${post.id}|${post.message}|${post.txid}`);
  const style = post.artStyle || classifyArt(post.message, post.messageKind, seed);
  const svg = compose(style, post, seed);
  writeFileSync(dest, svg);
  return { style, bytes: Buffer.byteLength(svg) };
}

function compose(style, post, seed) {
  const rand = rng(seed);
  const palette = PALETTES[style] || PALETTES.surreal;
  const grain = `<filter id="g"><feTurbulence type="fractalNoise" baseFrequency="${0.6 + rand() * 0.8}" numOctaves="3" seed="${seed % 999}"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .16 0"/></filter>`;
  const body = {
    romance: romance,
    cinematic: cinematic,
    freedom: freedom,
    lightning: lightning,
    rust: rust,
    data: dataArt,
    playful: playful,
    bitcoin: bitcoin,
    celebration: celebration,
    type: typographic,
    surreal: surreal,
  }[style] || surreal;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="1080" height="1080">
  <defs>${grain}${body.defs ? body.defs(palette, rand, seed) : ""}</defs>
  ${body(palette, rand, post, seed)}
  <rect width="1080" height="1080" filter="url(#g)" opacity=".28"/>
</svg>`;
}

function romance(p, rand) {
  const orbs = Array.from({ length: 8 }, (_, i) => {
    const x = 180 + rand() * 720;
    const y = 160 + rand() * 720;
    const r = 60 + rand() * 220;
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${p[2 + (i % 3)]}" opacity="${0.12 + rand() * 0.25}"/>`;
  }).join("");
  return `
    <rect width="1080" height="1080" fill="${p[0]}"/>
    <radialGradient id="rg" cx="35%" cy="30%"><stop offset="0" stop-color="${p[3]}"/><stop offset="1" stop-color="${p[0]}"/></radialGradient>
    <rect width="1080" height="1080" fill="url(#rg)"/>
    ${orbs}
    <path d="M540 430c40-90 180-90 180 20 0 140-180 230-180 230S360 590 360 450c0-110 140-110 180-20Z" fill="${p[2]}" opacity=".55"/>
    <ellipse cx="540" cy="880" rx="280" ry="40" fill="${p[1]}" opacity=".35"/>`;
}
romance.defs = () => "";

function cinematic(p, rand) {
  const hills = [780, 820, 860].map((y, i) => {
    const d = `M0 ${y} C ${200 + rand() * 80} ${y - 80 - i * 20}, ${520 + rand() * 80} ${y + 40}, 1080 ${y - 30} V1080 H0 Z`;
    return `<path d="${d}" fill="${p[1 + i]}" opacity="${0.45 + i * 0.15}"/>`;
  }).join("");
  return `
    <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p[1]}"/><stop offset=".55" stop-color="${p[2]}"/><stop offset="1" stop-color="${p[0]}"/></linearGradient></defs>
    <rect width="1080" height="1080" fill="url(#sky)"/>
    <circle cx="${720 + rand() * 80}" cy="${280 + rand() * 40}" r="90" fill="${p[3]}"/>
    ${hills}
    <rect y="980" width="1080" height="100" fill="#000" opacity=".55"/>`;
}

function freedom(p, rand) {
  return cinematic(p, rand).replaceAll("sky", "freeSky");
}

function lightning(p, rand) {
  const bolts = Array.from({ length: 4 }, () => {
    let x = 200 + rand() * 680;
    let y = 80;
    let d = `M${x} ${y}`;
    for (let i = 0; i < 8; i += 1) {
      x += (rand() - 0.45) * 90;
      y += 80 + rand() * 40;
      d += ` L${x} ${y}`;
    }
    return `<path d="${d}" fill="none" stroke="${p[3]}" stroke-width="${6 + rand() * 8}" stroke-linecap="round" opacity=".85"/>`;
  }).join("");
  const traces = Array.from({ length: 18 }, () => {
    const y = 80 + rand() * 920;
    return `<path d="M0 ${y} H${120 + rand() * 400}" stroke="${p[2]}" stroke-width="2" opacity=".35"/>`;
  }).join("");
  return `
    <rect width="1080" height="1080" fill="${p[0]}"/>
    ${traces}
    ${bolts}
    <circle cx="540" cy="540" r="16" fill="${p[4]}"/>`;
}

function rust(p, rand) {
  const plates = Array.from({ length: 12 }, (_, i) => {
    const x = (i % 4) * 270 + rand() * 20;
    const y = Math.floor(i / 4) * 360 + rand() * 20;
    return `<rect x="${x}" y="${y}" width="250" height="330" rx="18" fill="${i % 2 ? p[2] : p[1]}" opacity=".88"/>`;
  }).join("");
  return `
    <rect width="1080" height="1080" fill="${p[0]}"/>
    ${plates}
    <circle cx="780" cy="260" r="70" fill="${p[4]}"/>
    <path d="M200 820c80-40 140-20 200 10 70 40 140 20 220-10" fill="none" stroke="${p[3]}" stroke-width="14"/>`;
}

function dataArt(p, rand, post) {
  const cells = [];
  const src = (post.message || "OPRETURN").toUpperCase();
  for (let y = 0; y < 18; y += 1) {
    for (let x = 0; x < 18; x += 1) {
      const on = rand() > 0.45;
      if (!on) continue;
      const ch = src[(x + y * 3) % src.length];
      cells.push(`<rect x="${40 + x * 56}" y="${40 + y * 56}" width="46" height="46" fill="${p[1 + ((x + y) % 3)]}" opacity=".8"/>
        <text x="${63 + x * 56}" y="${72 + y * 56}" text-anchor="middle" font-family="ui-monospace,monospace" font-size="16" fill="${p[4]}">${escapeXml(ch)}</text>`);
    }
  }
  return `<rect width="1080" height="1080" fill="${p[0]}"/>${cells.join("")}`;
}

function playful(p, rand) {
  const blocks = Array.from({ length: 48 }, () => {
    const s = 40 + Math.floor(rand() * 5) * 24;
    return `<rect x="${rand() * 980}" y="${rand() * 980}" width="${s}" height="${s}" fill="${p[1 + Math.floor(rand() * 4)]}"/>`;
  }).join("");
  return `<rect width="1080" height="1080" fill="${p[0]}"/>${blocks}`;
}

function bitcoin(p, rand) {
  const rings = [120, 200, 280, 360, 460].map((r, i) =>
    `<circle cx="540" cy="500" r="${r}" fill="none" stroke="${p[2]}" stroke-width="${i === 2 ? 18 : 6}" opacity="${0.25 + i * 0.12}"/>`
  ).join("");
  return `
    <rect width="1080" height="1080" fill="${p[0]}"/>
    <circle cx="540" cy="500" r="210" fill="${p[2]}"/>
    <text x="540" y="530" text-anchor="middle" font-family="Georgia,serif" font-size="180" fill="${p[0]}">₿</text>
    ${rings}
    <rect y="860" width="1080" height="220" fill="${p[1]}"/>`;
}

function celebration(p, rand) {
  const bits = Array.from({ length: 70 }, () => {
    const x = rand() * 1080;
    const y = rand() * 1080;
    return `<rect x="${x}" y="${y}" width="${8 + rand() * 18}" height="${18 + rand() * 40}" rx="3" transform="rotate(${rand() * 360} ${x} ${y})" fill="${p[1 + Math.floor(rand() * 4)]}"/>`;
  }).join("");
  return `
    <rect width="1080" height="1080" fill="${p[0]}"/>
    <circle cx="540" cy="540" r="220" fill="${p[2]}" opacity=".35"/>
    ${bits}`;
}

function typographic(p, rand, post) {
  const words = (post.message || "OP RETURN").split(/\s+/).slice(0, 4);
  const lines = words.map((word, i) => {
    const size = 90 + (3 - i) * 28;
    return `<text x="80" y="${280 + i * 140}" font-family="Inter,Arial,sans-serif" font-weight="800" font-size="${size}" fill="${i === 1 ? p[3] : p[2]}">${escapeXml(word.slice(0, 16))}</text>`;
  }).join("");
  return `
    <rect width="1080" height="1080" fill="${p[0]}"/>
    <rect x="64" y="64" width="952" height="952" fill="none" stroke="${p[3]}" stroke-width="10"/>
    ${lines}`;
}

function surreal(p, rand) {
  const arches = Array.from({ length: 6 }, (_, i) => {
    const x = 120 + i * 150;
    return `<path d="M${x} 900 V${300 + rand() * 200} A40 40 0 0 1 ${x + 80} ${300 + rand() * 120} V900" fill="${p[1 + (i % 3)]}" opacity=".8"/>`;
  }).join("");
  return `
    <rect width="1080" height="1080" fill="${p[0]}"/>
    <circle cx="${200 + rand() * 200}" cy="180" r="50" fill="${p[3]}"/>
    <circle cx="${700 + rand() * 180}" cy="220" r="28" fill="${p[4]}"/>
    ${arches}
    <ellipse cx="540" cy="940" rx="420" ry="50" fill="${p[2]}" opacity=".35"/>`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function maybeProviderImage(post, options = {}) {
  const provider = options.provider || process.env.INSTAOP_IMAGE_PROVIDER || "";
  const key = options.apiKey || process.env.INSTAOP_IMAGE_KEY || process.env.OPENAI_API_KEY || "";
  if (!provider || provider === "none" || !key) return null;
  if (provider !== "openai") return null;
  const fetchImpl = options.fetchImpl || fetch;
  try {
    const res = await fetchImpl("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "dall-e-3",
        size: "1024x1024",
        response_format: "b64_json",
        prompt: `Square Instagram photograph, no text, no watermark. Mood from this Bitcoin OP_RETURN: ${(post.message || "onchain").slice(0, 240)}`,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const b64 = body.data?.[0]?.b64_json;
    if (!b64) return null;
    return { bytes: Buffer.from(b64, "base64"), ext: ".png" };
  } catch {
    return null;
  }
}
