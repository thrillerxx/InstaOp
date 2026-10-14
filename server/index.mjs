import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, publicPost } from "./store.mjs";
import { classifyArt, composeVoice, hashSeed, inspectMessage } from "./captions.mjs";
import { renderArtwork } from "./art.mjs";
import { lookupConfirmed, startIngest } from "./nostr.mjs";
import { sendNostrOtp } from "./nostr-otp.mjs";
import { verifyOtp } from "./otp-store.mjs";
import { createSession, verifySession, destroySession, parseCookie, SESSION_MAX_AGE_SECONDS } from "./session.mjs";
import { rateLimit } from "./rate-limit.mjs";
import { DEFAULT_RELAYS, SESSION_COOKIE } from "./nostr-config.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const publicDir = join(root, "public");
const dataDir = process.env.INSTAOP_DATA || join(root, "data");
const bind = process.env.INSTAOP_BIND || "127.0.0.1";
const port = Number(process.env.INSTAOP_PORT || 8788);

const store = createStore(dataDir);
const clients = new Set();
const queue = [];
const queued = new Set();
let working = false;

const ingest = startIngest({
  since: store.lastSeen(),
  onEvent: (event) => acceptEvent(event, false),
});

function acceptEvent(event, demo) {
  const inspected = inspectMessage(event.message);
  const seed = hashSeed(event.id + inspected.message);
  const voice = composeVoice(inspected.message, inspected.messageKind, seed);
  const artStyle = classifyArt(inspected.message, inspected.messageKind, seed);
  const { post, created } = store.upsert({
    id: event.id,
    txid: event.txid || "",
    message: inspected.message,
    messageKind: inspected.messageKind,
    bytes: inspected.bytes,
    note: voice.note,
    hashtags: voice.hashtags,
    created_at: event.created_at,
    demo,
    artStatus: "pending",
    artStyle,
    confirmed: null,
  });
  if (!created) return post;
  enqueue(post.id);
  if (post.txid) verifyTx(post.id, post.txid);
  broadcast({ type: "post", post: publicPost(post, store) });
  return post;
}

function enqueue(id) {
  if (queued.has(id)) return;
  queued.add(id);
  queue.push(id);
  pump();
}

async function pump() {
  if (working) return;
  const id = queue.shift();
  if (!id) return;
  working = true;
  const post = store.get(id);
  try {
    if (post && (post.artStatus !== "ready" || !existsSync(store.imagePath(id)))) {
      renderArtwork(post, store.imagePath(id));
      const ready = store.update(id, { artStatus: "ready" });
      broadcast({ type: "art", post: publicPost(ready, store) });
    }
  } catch (err) {
    console.error("art failed", id, err.message);
    store.update(id, { artStatus: "failed" });
  } finally {
    queued.delete(id);
    working = false;
    if (queue.length) setTimeout(pump, 30);
  }
}

async function verifyTx(id, txid) {
  const confirmed = await lookupConfirmed(txid);
  if (confirmed === null) return;
  const ready = store.update(id, { confirmed });
  if (ready) broadcast({ type: "status", post: publicPost(ready, store) });
}

function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(frame);
}

store.pendingArt().forEach((post) => enqueue(post.id));

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
};

function sendJson(res, code, body) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function serveFile(res, file, extra = {}) {
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const type = mime[extname(file)] || "application/octet-stream";
  res.writeHead(200, { "content-type": type, ...extra });
  createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function listPosts(url) {
  const tag = (url.searchParams.get("tag") || "").replace(/^#/, "").toLowerCase();
  const q = (url.searchParams.get("q") || "").toLowerCase();
  return store.all().filter((post) => {
    if (tag && !(post.hashtags || []).some((item) => item.toLowerCase() === tag)) return false;
    if (q && !`${post.message} ${post.note}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://instaop.local");

  // --- Nostr OTP auth (ported from livingry-ops PWA livingry-ops.livingry.services) ---
  if (url.pathname === "/api/auth/relays" && req.method === "GET") {
    return sendJson(res, 200, { options: DEFAULT_RELAYS, selected: DEFAULT_RELAYS.map(r=>r.id) });
  }
  if (url.pathname === "/api/auth/send" && req.method === "POST") {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
    const rl = rateLimit(`otp:send:${ip}`, { limit: 5, windowMs: 60*60*1000 });
    if (!rl.allowed) return sendJson(res, 429, { ok: false, error: `Too many requests. Try again in ${rl.retryAfterSec}s.` });
    let body={}; try { body = JSON.parse((await readBody(req))||"{}"); } catch {}
    const result = await sendNostrOtp({ npub: body.npub, relayUrls: body.relayUrls });
    if (!result.ok) return sendJson(res, result.status || 400, { ok: false, error: result.error });
    return sendJson(res, 200, { ok: true, sessionKey: result.sessionKey, relaysAttempted: result.relaysAttempted, relaysSucceeded: result.relaysSucceeded });
  }
  if (url.pathname === "/api/auth/verify" && req.method === "POST") {
    let body={}; try { body = JSON.parse((await readBody(req))||"{}"); } catch {}
    const { sessionKey, code } = body;
    if (!sessionKey || !code) return sendJson(res, 400, { ok: false, error: "Missing sessionKey or code." });
    const v = verifyOtp(String(sessionKey), String(code));
    if (!v.ok) return sendJson(res, 401, { ok: false, error: v.reason });
    const session = createSession(null);
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${session.cookieValue}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`);
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === "/api/auth/session" && req.method === "GET") {
    const granted = verifySession(parseCookie(req.headers.cookie||"", SESSION_COOKIE)) !== null;
    return sendJson(res, 200, { granted });
  }
  if (url.pathname === "/api/auth/session" && req.method === "DELETE") {
    const c = parseCookie(req.headers.cookie||"", SESSION_COOKIE);
    destroySession(c);
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/feed") {
    return sendJson(res, 200, {
      posts: listPosts(url).map((post) => publicPost(post, store)),
    });
  }

  if (url.pathname === "/api/status") {
    return sendJson(res, 200, {
      live: ingest.connected() > 0,
      relays: ingest.relays(),
      ingest: ingest.stats(),
      posts: store.all().length,
      provider: process.env.INSTAOP_IMAGE_PROVIDER || "procedural",
    });
  }

  if (url.pathname === "/api/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write("retry: 3000\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (url.pathname === "/api/demo" && req.method === "POST") {
    let message = "";
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      message = String(body.message || "").slice(0, 500);
    } catch {
      message = "";
    }
    const samples = [
      "OP_RETURN Bot now supports BOLT 12!",
      "now in rust",
      "BRAM | HAPPY BIRTHDAY | 210000 SATS | FOREVER ON BITCOIN",
      "orange pill the group chat",
      "this message outlives us both",
    ];
    const chosen = message || samples[Math.floor(Math.random() * samples.length)];
    const post = acceptEvent(
      {
        id: `demo-${Date.now()}`,
        created_at: Math.floor(Date.now() / 1000),
        message: chosen,
        txid: "",
      },
      true
    );
    return sendJson(res, 200, { post: publicPost(post, store) });
  }

  if (url.pathname.startsWith("/media/")) {
    const id = decodeURIComponent(url.pathname.slice(7));
    const file = store.imagePath(id);
    const post = store.get(id);
    if (!post || !existsSync(file)) {
      res.writeHead(404);
      res.end("pending");
      return;
    }
    return serveFile(res, file, {
      "cache-control": "public, max-age=31536000, immutable",
    });
  }

  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = join(publicDir, rel);
  if (!file.startsWith(publicDir)) {
    res.writeHead(403);
    res.end();
    return;
  }
  serveFile(res, file);
});

server.listen(port, bind, () => {
  console.log(`InstaOp listening on ${bind}:${port}`);
});
