import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStore, publicPost } from "./store.mjs";
import { classifyArt, composeVoice, hashSeed, inspectMessage } from "./captions.mjs";
import { renderArtwork } from "./art.mjs";
import { fetchMempoolPreview, squareMempoolSvg } from "./mempool-preview.mjs";
import { lookupConfirmed, startIngest } from "./nostr.mjs";
import { openDatabase } from "./db.mjs";
import { createAuth, SESSION_SECONDS } from "./auth.mjs";
import { avatarSvg, createSocial } from "./social.mjs";
import { createPublish } from "./publish.mjs";
import { createPay } from "./pay.mjs";
import { createOpReturnClient } from "./opreturn.mjs";
import { estimateSats, mempoolFastestRate, publishLimits } from "./limits.mjs";
import QRCode from "qrcode";
import {
  clearSessionCookie,
  clientIp,
  createLimiter,
  parseCookies,
  parseMultipart,
  readJson,
  readRaw,
  sendJson,
  sessionCookie,
} from "./http.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const publicDir = join(root, "public");

export function createApp(options = {}) {
  const dataDir = options.dataDir || process.env.INSTAOP_DATA || join(root, "data");
  const bind = options.bind || process.env.INSTAOP_BIND || "127.0.0.1";
  const port = Number(options.port || process.env.INSTAOP_PORT || 8788);
  const allowDemo = options.allowDemo ?? process.env.INSTAOP_ALLOW_DEMO === "1";
  const noIngest = options.noIngest ?? process.env.INSTAOP_NO_INGEST === "1";
  const paymentsEnabled = options.paymentsEnabled ?? process.env.INSTAOP_PAYMENTS === "1";
  const fetchPreview = options.fetchPreview || fetchMempoolPreview;

  const store = createStore(dataDir);
  const db = openDatabase(dataDir);
  const auth = createAuth(db);
  const social = createSocial(db, { dataDir, auth });
  const publish = createPublish(db, { dataDir });
  const official = social.ensureEveryoneFollowsOfficial();
  const bot = options.bot || (paymentsEnabled ? createOpReturnClient() : null);
  const clients = new Set();
  const queue = [];
  const queued = new Set();
  let working = false;
  const authLimit = createLimiter({ max: 12 });
  const writeLimit = createLimiter({ max: 40 });

  for (const post of store.all()) social.importPost(post);

  const ingest = noIngest
    ? { connected: () => 0, relays: () => [], stats: () => ({ seen: 0, accepted: 0 }) }
    : startIngest({
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
    if (!demo) social.importPost(post);
    enqueue(post.id);
    if (post.txid) verifyTx(post.id, post.txid);
    broadcast({ type: "post", post: decorate(post) });
    return post;
  }

  function shouldUseMempoolPreview(post) {
    return Boolean(post?.txid) && !post.demo && social.isOfficialImport(post.id);
  }

  function shouldRefreshOfficialPreview(post) {
    return shouldUseMempoolPreview(post) && post.artStyle !== "mempool";
  }

  async function paintPost(post) {
    if (shouldUseMempoolPreview(post)) {
      try {
        const png = await fetchPreview(post.txid);
        store.writeImage(post.id, Buffer.from(squareMempoolSvg(png)), ".svg");
        post.artStyle = "mempool";
        return;
      } catch (err) {
        console.error("mempool preview failed", post.id, err.message);
      }
    }
    renderArtwork(post, store.imagePath(post.id));
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
      if (post && (post.artStatus !== "ready" || !existsSync(store.imagePath(id)) || shouldRefreshOfficialPreview(post))) {
        await paintPost(post);
        const ready = store.update(id, { artStatus: "ready", artStyle: post.artStyle });
        broadcast({ type: "art", post: decorate(ready) });
      }
    } catch (err) {
      console.error("art failed", id, err.message);
      store.update(id, { artStatus: "failed" });
    } finally {
      queued.delete(id);
      working = false;
      if (queue.length) setTimeout(pump, 200);
    }
  }

  const confirmTx = options.lookupConfirmed || lookupConfirmed;

  async function verifyTx(id, txid) {
    const confirmed = await confirmTx(txid);
    if (confirmed === null) return;
    const ready = store.update(id, { confirmed });
    if (ready) broadcast({ type: "status", post: decorate(ready) });
  }

  function broadcast(payload) {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(frame);
  }

  function decorate(post, viewer = null) {
    if (!post || post.demo) return null;
    const publicRow = publicPost(post, store);
    return social.decorate(publicRow, viewer?.id || null);
  }

  const pay = createPay({
    publish,
    bot,
    store,
    social,
    lookupConfirmed: confirmTx,
    paymentsEnabled,
    onPublished(post) {
      if (post.artStatus !== "ready") enqueue(post.id);
      broadcast({ type: "post", post: decorate(post) });
    },
  });
  const watchTimer = paymentsEnabled
    ? setInterval(() => pay.watchAll().catch((err) => console.error("pay watch", err.message)), 8000)
    : null;
  if (watchTimer) watchTimer.unref();

  function viewerFrom(req) {
    const token = parseCookies(req).io_sid;
    const user = auth.userFromSession(token);
    return user ? { user, token } : { user: null, token: token || null };
  }

  function published() {
    return store.all().filter((post) => !post.demo);
  }

  function listPosts(url, viewer) {
    const tag = (url.searchParams.get("tag") || "").replace(/^#/, "").toLowerCase();
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const tab = url.searchParams.get("tab") || "live";
    const homeAuthors = viewer && tab === "home" ? social.homeIds(viewer.id) : null;
    return published()
      .filter((post) => {
        if (tag && !(post.hashtags || []).some((item) => item.toLowerCase() === tag)) return false;
        if (q && !`${post.message} ${post.note}`.toLowerCase().includes(q)) return false;
        if (homeAuthors) {
          const row = social.decorate(publicPost(post, store), viewer.id);
          return row && homeAuthors.has(row.author.id);
        }
        return true;
      })
      .map((post) => decorate(post, viewer))
      .filter(Boolean);
  }

  store.pendingArt().forEach((post) => enqueue(post.id));
  store.all().filter(shouldRefreshOfficialPreview).forEach((post) => enqueue(post.id));

  const mime = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".png": "image/png",
    ".webp": "image/webp",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
  };

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

  function fail(res, err) {
    const code = err.status || 400;
    sendJson(res, code, { error: err.message || "request failed" });
  }

  function requireUser(req, res) {
    const { user } = viewerFrom(req);
    if (!user) {
      sendJson(res, 401, { error: "Sign in to do that." });
      return null;
    }
    return user;
  }

  async function handler(req, res) {
    const url = new URL(req.url, "http://instaop.local");
    const { user } = viewerFrom(req);
    const path = url.pathname;

    try {
      if (path === "/api/feed") {
        return sendJson(res, 200, { posts: listPosts(url, user) });
      }

      if (path === "/api/health") {
        return sendJson(res, 200, { ok: true, phase: 3, schema: 2, payments: paymentsEnabled });
      }

      if (path === "/api/status") {
        return sendJson(res, 200, {
          live: ingest.connected() > 0,
          relays: ingest.relays(),
          ingest: ingest.stats(),
          posts: published().length,
          provider: process.env.INSTAOP_IMAGE_PROVIDER || "procedural",
          publishing: { enabled: paymentsEnabled, phase: 3, payments: paymentsEnabled },
        });
      }

      if (path === "/api/stream") {
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

      if (path === "/api/me" && req.method === "GET") {
        if (!user) return sendJson(res, 200, { user: null });
        return sendJson(res, 200, {
          user: social.publicUser(user, user.id),
          notifications: social.notifications(user.id),
        });
      }

      if (path === "/api/me" && req.method === "PATCH") {
        if (!requireUser(req, res)) return;
        const body = await readJson(req);
        return sendJson(res, 200, { user: social.updateProfile(user.id, body) });
      }

      if (path === "/api/me" && req.method === "DELETE") {
        if (!requireUser(req, res)) return;
        const result = social.deleteAccount(user.id);
        return sendJson(res, 200, result, { "set-cookie": clearSessionCookie(req) });
      }

      if (path === "/api/me/avatar" && req.method === "POST") {
        if (!requireUser(req, res)) return;
        const raw = await readRaw(req, 2_200_000);
        const parts = parseMultipart(raw, req.headers["content-type"]);
        const file = parts.find((part) => part.name === "avatar" || part.filename);
        if (!file) return sendJson(res, 400, { error: "Attach a photo." });
        return sendJson(res, 200, { user: await social.saveAvatar(user.id, file) });
      }

      if (path === "/api/auth/register" && req.method === "POST") {
        if (!authLimit(clientIp(req))) return sendJson(res, 429, { error: "Too many attempts. Wait a minute." });
        const body = await readJson(req);
        const created = social.register(body);
        const token = auth.issueSession(created.id);
        return sendJson(res, 201, { user: social.publicUser(created, created.id) }, {
          "set-cookie": sessionCookie(token, req, SESSION_SECONDS),
        });
      }

      if (path === "/api/auth/login" && req.method === "POST") {
        if (!authLimit(clientIp(req))) return sendJson(res, 429, { error: "Too many attempts. Wait a minute." });
        const body = await readJson(req);
        const found = auth.login(body.identifier || body.email || body.username, body.password);
        const token = auth.issueSession(found.id);
        return sendJson(res, 200, { user: social.publicUser(found, found.id) }, {
          "set-cookie": sessionCookie(token, req, SESSION_SECONDS),
        });
      }

      if (path === "/api/auth/logout" && req.method === "POST") {
        const { token } = viewerFrom(req);
        auth.clearSession(token);
        return sendJson(res, 200, { ok: true }, { "set-cookie": clearSessionCookie(req) });
      }

      if (path === "/api/auth/nostr/challenge" && req.method === "GET") {
        return sendJson(res, 200, auth.issueChallenge());
      }

      if (path === "/api/auth/nostr" && req.method === "POST") {
        if (!authLimit(clientIp(req))) return sendJson(res, 429, { error: "Too many attempts. Wait a minute." });
        const body = await readJson(req);
        const created = social.loginNostr(body.event || body, body.challenge || body.nonce);
        const token = auth.issueSession(created.id);
        return sendJson(res, 200, { user: social.publicUser(created, created.id) }, {
          "set-cookie": sessionCookie(token, req, SESSION_SECONDS),
        });
      }

      if (path.startsWith("/api/users/") && path.endsWith("/follow") && req.method === "POST") {
        if (!requireUser(req, res)) return;
        const username = decodeURIComponent(path.slice("/api/users/".length, -"/follow".length));
        return sendJson(res, 200, { user: social.follow(user.id, username) });
      }

      if (path.startsWith("/api/users/") && path.endsWith("/follow") && req.method === "DELETE") {
        if (!requireUser(req, res)) return;
        const username = decodeURIComponent(path.slice("/api/users/".length, -"/follow".length));
        return sendJson(res, 200, { user: social.unfollow(user.id, username) });
      }

      if (path.startsWith("/api/users/") && path.endsWith("/block") && req.method === "POST") {
        if (!requireUser(req, res)) return;
        const username = decodeURIComponent(path.slice("/api/users/".length, -"/block".length));
        return sendJson(res, 200, social.block(user.id, username));
      }

      if (path === "/api/users" && req.method === "GET") {
        return sendJson(res, 200, { users: social.searchUsers(url.searchParams.get("q") || "") });
      }

      if (path.startsWith("/api/users/") && req.method === "GET") {
        const username = decodeURIComponent(path.slice("/api/users/".length));
        const profile = social.profile(username, user?.id || null);
        if (!profile) return sendJson(res, 404, { error: "Account not found." });
        const ids = new Set(
          published()
            .map((post) => decorate(post, user))
            .filter((post) => post && post.author.username === profile.username)
            .map((post) => post.id)
        );
        const posts = published()
          .filter((post) => ids.has(post.id))
          .map((post) => decorate(post, user))
          .filter(Boolean);
        return sendJson(res, 200, { user: { ...profile, postCount: posts.length }, posts });
      }

      if (path.startsWith("/api/posts/") && path.endsWith("/like") && req.method === "POST") {
        if (!requireUser(req, res)) return;
        if (!writeLimit(`${user.id}:like`)) return sendJson(res, 429, { error: "Slow down." });
        const id = decodeURIComponent(path.slice("/api/posts/".length, -"/like".length));
        return sendJson(res, 200, social.like(user.id, id));
      }

      if (path.startsWith("/api/posts/") && path.endsWith("/like") && req.method === "DELETE") {
        if (!requireUser(req, res)) return;
        const id = decodeURIComponent(path.slice("/api/posts/".length, -"/like".length));
        return sendJson(res, 200, social.unlike(user.id, id));
      }

      if (path.startsWith("/api/posts/") && path.endsWith("/save") && req.method === "POST") {
        if (!requireUser(req, res)) return;
        const id = decodeURIComponent(path.slice("/api/posts/".length, -"/save".length));
        return sendJson(res, 200, social.save(user.id, id));
      }

      if (path.startsWith("/api/posts/") && path.endsWith("/save") && req.method === "DELETE") {
        if (!requireUser(req, res)) return;
        const id = decodeURIComponent(path.slice("/api/posts/".length, -"/save".length));
        return sendJson(res, 200, social.unsave(user.id, id));
      }

      if (path.startsWith("/api/posts/") && path.endsWith("/comments") && req.method === "GET") {
        const id = decodeURIComponent(path.slice("/api/posts/".length, -"/comments".length));
        return sendJson(res, 200, { comments: social.comments(id), ...social.counts(id, user?.id || null) });
      }

      if (path.startsWith("/api/posts/") && path.endsWith("/comments") && req.method === "POST") {
        if (!requireUser(req, res)) return;
        if (!writeLimit(`${user.id}:comment`)) return sendJson(res, 429, { error: "Slow down." });
        const id = decodeURIComponent(path.slice("/api/posts/".length, -"/comments".length));
        const body = await readJson(req);
        return sendJson(res, 201, social.comment(user.id, id, body.body, body.parentId || null));
      }

      if (path.startsWith("/api/comments/") && req.method === "DELETE") {
        if (!requireUser(req, res)) return;
        const id = decodeURIComponent(path.slice("/api/comments/".length));
        return sendJson(res, 200, social.deleteComment(user.id, id));
      }

      if (path === "/api/saved") {
        if (!requireUser(req, res)) return;
        const ids = new Set(social.savedIds(user.id));
        return sendJson(res, 200, {
          posts: published().filter((post) => ids.has(post.id)).map((post) => decorate(post, user)).filter(Boolean),
        });
      }

      if (path === "/api/notifications" && req.method === "GET") {
        if (!requireUser(req, res)) return;
        return sendJson(res, 200, social.notifications(user.id));
      }

      if (path === "/api/notifications/read" && req.method === "POST") {
        if (!requireUser(req, res)) return;
        return sendJson(res, 200, social.markNotificationsRead(user.id));
      }

      if (path === "/api/report" && req.method === "POST") {
        if (!requireUser(req, res)) return;
        return sendJson(res, 200, social.report(user.id, await readJson(req)));
      }

      if (path === "/api/suggested") {
        return sendJson(res, 200, { users: social.listSuggested(user?.id || null) });
      }

      if (path === "/api/publish/limits" && req.method === "GET") {
        const feeRate = await mempoolFastestRate();
        return sendJson(res, 200, { ...publishLimits(), feeRate, sample: estimateSats(80, { feeRate }) });
      }

      if (path === "/api/publish/shorten" && req.method === "POST") {
        if (!requireUser(req, res)) return;
        const body = await readJson(req);
        return sendJson(res, 200, publish.shorten(body.statement || body.text || ""));
      }

      if (path === "/api/publish/drafts" && req.method === "GET") {
        if (!requireUser(req, res)) return;
        return sendJson(res, 200, { drafts: publish.list(user.id) });
      }

      if (path === "/api/publish/drafts" && req.method === "POST") {
        if (!requireUser(req, res)) return;
        if (!writeLimit(`${user.id}:draft`)) return sendJson(res, 429, { error: "Slow down." });
        return sendJson(res, 201, { draft: publish.create(user.id, await readJson(req)) });
      }

      if (path.startsWith("/api/publish/drafts/") && path.endsWith("/image") && req.method === "POST") {
        if (!requireUser(req, res)) return;
        const id = decodeURIComponent(path.slice("/api/publish/drafts/".length, -"/image".length));
        const raw = await readRaw(req, 9_000_000);
        const parts = parseMultipart(raw, req.headers["content-type"], 8_000_000);
        const original = parts.find((part) => part.name === "original")?.body;
        const payload = parts.find((part) => part.name === "payload")?.body;
        const width = Number(parts.find((part) => part.name === "width")?.body?.toString() || 0);
        const height = Number(parts.find((part) => part.name === "height")?.body?.toString() || 0);
        const mime = parts.find((part) => part.name === "mime")?.body?.toString() || "";
        return sendJson(res, 200, { draft: publish.attachImage(user.id, id, { original, payload, width, height, mime }) });
      }

      if (path.startsWith("/api/publish/drafts/") && path.endsWith("/pay") && req.method === "POST") {
        if (!requireUser(req, res)) return;
        if (!writeLimit(`${user.id}:pay`)) return sendJson(res, 429, { error: "Slow down." });
        const id = decodeURIComponent(path.slice("/api/publish/drafts/".length, -"/pay".length));
        const paid = await pay.pay(user.id, id);
        return sendJson(res, 200, paid);
      }

      if (path.startsWith("/api/publish/drafts/") && path.endsWith("/refresh") && req.method === "POST") {
        if (!requireUser(req, res)) return;
        const id = decodeURIComponent(path.slice("/api/publish/drafts/".length, -"/refresh".length));
        return sendJson(res, 200, { draft: await pay.refresh(user.id, id) });
      }

      if (path.startsWith("/api/publish/drafts/") && path.endsWith("/qr") && req.method === "GET") {
        if (!requireUser(req, res)) return;
        const id = decodeURIComponent(path.slice("/api/publish/drafts/".length, -"/qr".length));
        const draft = publish.get(user.id, id);
        if (!draft.invoice) return sendJson(res, 404, { error: "No invoice yet." });
        const png = await QRCode.toBuffer(draft.invoice, { type: "png", width: 280, margin: 1 });
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(png);
        return;
      }

      if (path.startsWith("/api/publish/drafts/") && path.endsWith("/ready") && req.method === "POST") {
        if (!requireUser(req, res)) return;
        const id = decodeURIComponent(path.slice("/api/publish/drafts/".length, -"/ready".length));
        const body = await readJson(req);
        return sendJson(res, 200, { draft: publish.ready(user.id, id, body) });
      }

      if (path.startsWith("/api/publish/drafts/") && path.endsWith("/estimate") && req.method === "GET") {
        if (!requireUser(req, res)) return;
        const id = decodeURIComponent(path.slice("/api/publish/drafts/".length, -"/estimate".length));
        const feeRate = await mempoolFastestRate();
        return sendJson(res, 200, publish.estimate(user.id, id, feeRate));
      }

      if (path.startsWith("/api/publish/drafts/") && req.method === "GET") {
        if (!requireUser(req, res)) return;
        const id = decodeURIComponent(path.slice("/api/publish/drafts/".length));
        return sendJson(res, 200, { draft: publish.get(user.id, id) });
      }

      if (path.startsWith("/api/publish/drafts/") && req.method === "PATCH") {
        if (!requireUser(req, res)) return;
        const id = decodeURIComponent(path.slice("/api/publish/drafts/".length));
        return sendJson(res, 200, { draft: publish.update(user.id, id, await readJson(req)) });
      }

      if (path.startsWith("/api/publish/drafts/") && req.method === "DELETE") {
        if (!requireUser(req, res)) return;
        const id = decodeURIComponent(path.slice("/api/publish/drafts/".length));
        return sendJson(res, 200, publish.remove(user.id, id));
      }

      if (path.startsWith("/media/draft/")) {
        if (!requireUser(req, res)) return;
        const rest = path.slice("/media/draft/".length);
        const [id, which] = rest.split("/");
        const found = publish.file(user.id, decodeURIComponent(id), which === "original" ? "original" : "preview");
        if (!found) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        return serveFile(res, found.file, { "cache-control": "private, max-age=60", "content-type": found.type });
      }

      if (path === "/api/publish/pay" && req.method === "POST") {
        if (!paymentsEnabled) {
          return sendJson(res, 403, {
            error: "Lightning payments are not enabled. Your draft stays private until a confirmed OP_RETURN exists.",
          });
        }
        if (!requireUser(req, res)) return;
        const body = await readJson(req);
        if (!body.draftId) return sendJson(res, 400, { error: "Missing draftId." });
        const paid = await pay.pay(user.id, body.draftId);
        return sendJson(res, 200, paid);
      }

      if (path === "/api/publish" && req.method === "POST") {
        return sendJson(res, 403, {
          error: "No public post without a confirmed Bitcoin transaction. Save a draft and wait for Lightning publishing.",
        });
      }

      if (path === "/api/demo" && req.method === "POST") {
        if (!allowDemo) return sendJson(res, 403, { error: "Demo posts are off. Public posts require a confirmed Bitcoin transaction." });
        const body = await readJson(req);
        const post = acceptEvent(
          {
            id: `demo-${Date.now()}`,
            created_at: Math.floor(Date.now() / 1000),
            message: String(body.message || "demo"),
            txid: "",
          },
          true
        );
        return sendJson(res, 200, { post: publicPost(post, store) });
      }

      if (path.startsWith("/media/avatar/")) {
        const key = decodeURIComponent(path.slice("/media/avatar/".length));
        const found = social.avatarFile(key);
        if (found?.file) return serveFile(res, found.file, { "cache-control": "private, max-age=3600" });
        if (found?.official) {
          const logo = join(publicDir, "opreturn-avatar.svg");
          if (existsSync(logo)) return serveFile(res, logo, { "cache-control": "public, max-age=86400" });
        }
        const svg = found?.svg || avatarSvg(key, key);
        res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" });
        res.end(svg);
        return;
      }

      if (path.startsWith("/media/")) {
        const id = decodeURIComponent(path.slice(7));
        const file = store.imagePath(id);
        const post = store.get(id);
        if (!post || post.demo || !existsSync(file)) {
          res.writeHead(404);
          res.end("pending");
          return;
        }
        return serveFile(res, file, {
          "cache-control": "public, max-age=31536000, immutable",
        });
      }

      const rel = path === "/" ? "/index.html" : path;
      const file = join(publicDir, rel);
      if (!file.startsWith(publicDir)) {
        res.writeHead(403);
        res.end();
        return;
      }
      serveFile(res, file);
    } catch (err) {
      if (err.status) return fail(res, err);
      console.error(req.method, path, err);
      sendJson(res, 500, { error: "Something broke. Try again." });
    }
  }

  const server = createServer(handler);
  return {
    server,
    handler,
    store,
    social,
    auth,
    official,
    listen() {
      return new Promise((resolve) => {
        server.listen(port, bind, () => {
          console.log(`InstaOp listening on ${bind}:${port}`);
          resolve(server.address());
        });
      });
    },
    close() {
      if (watchTimer) clearInterval(watchTimer);
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen();
}
