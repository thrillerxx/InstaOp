import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./index.mjs";
import { HARD_MAX, estimateSats, utf8Bytes } from "./limits.mjs";
import { buildPayload, parsePayload, suggestShorten } from "./optimize.mjs";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wAAAAD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAf/2gAIAQEAAQUCf//Z",
  "base64"
);

function form(fields) {
  const boundary = "----instaoptest";
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\n`));
    if (value && value.body) {
      parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"; filename="${value.filename}"\r\nContent-Type: ${value.type}\r\n\r\n`));
      parts.push(value.body);
      parts.push(Buffer.from("\r\n"));
    } else {
      parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

assert(utf8Bytes("⚡") === 3, "emoji is 3 bytes");
assert(utf8Bytes("hi") === 2, "ascii is 1 byte each");
const short = suggestShorten("I just really actually love Bitcoin forever");
assert(short.suggested.includes("love Bitcoin"), "keeps meaning");
assert(short.applied === false, "does not auto-apply");
assert(short.suggestedBytes < short.originalBytes, "saves bytes");

const both = buildPayload({ statement: "hello", image: { mime: "image/jpeg", bytes: JPEG } });
const parsed = parsePayload(both);
assert(parsed.kind === "both" && parsed.statement === "hello", "envelope statement");
assert(parsed.image.bytes.equals(JPEG), "envelope keeps exact image bytes");

const over = estimateSats(HARD_MAX + 1);
assert(over.ok === false, "estimate rejects over hard max");
const under = estimateSats(40, { feeRate: 5, noTwitter: true });
assert(under.ok && under.sats > 1337 && under.standard, "small text estimate");

const dir = mkdtempSync(join(tmpdir(), "instaop-pub-"));
writeFileSync(join(dir, "posts.json"), JSON.stringify({ lastSeen: 0, posts: {} }));
const app = createApp({
  dataDir: dir,
  bind: "127.0.0.1",
  port: 0,
  noIngest: true,
  allowDemo: false,
  fetchPreview: async () => { throw new Error("tests do not fetch mempool previews"); },
});
const addr = await new Promise((resolve) => app.server.listen(0, "127.0.0.1", () => resolve(app.server.address())));
const base = `http://127.0.0.1:${addr.port}`;

async function req(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["content-type"] && !options.raw) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  const set = res.headers.getSetCookie?.() || res.headers.get("set-cookie");
  return { res, body, cookie: Array.isArray(set) ? set[0] : set };
}

function sid(setCookie) {
  return setCookie ? setCookie.split(";")[0] : "";
}

try {
  const guest = await req("/api/publish/drafts", { method: "POST", body: JSON.stringify({ statement: "hi" }) });
  assert(guest.res.status === 401, "guest cannot draft");

  const user = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: "mina", email: "mina@example.com", password: "password1", displayName: "Mina" }),
  });
  const cookie = sid(user.cookie);

  const instant = await req("/api/publish", { method: "POST", body: "{}", headers: { cookie } });
  assert(instant.res.status === 403, "no instant public post");

  const pay = await req("/api/publish/pay", { method: "POST", body: "{}", headers: { cookie } });
  assert(pay.res.status === 403, "no lightning yet");

  const created = await req("/api/publish/drafts", {
    method: "POST",
    body: JSON.stringify({ statement: "hello chain", caption: "offchain note", hashtags: ["Bitcoin"] }),
    headers: { cookie },
  });
  assert(created.res.status === 201, "draft created");
  assert(created.body.draft.status === "draft", "stays draft");
  assert(created.body.draft.byteCount === utf8Bytes("hello chain"), "utf8 byte count");
  const id = created.body.draft.id;

  const feed = await req("/api/feed?tab=live");
  assert(!feed.body.posts.some((post) => post.id === id), "draft is not a public post");

  const huge = "x".repeat(HARD_MAX + 50);
  const tooBig = await req(`/api/publish/drafts/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ statement: huge }),
    headers: { cookie },
  });
  assert(tooBig.body.draft.overLimit === true, "over-limit draft stays unpublished");
  const readyHuge = await req(`/api/publish/drafts/${id}/ready`, {
    method: "POST",
    body: JSON.stringify({ consent: true }),
    headers: { cookie },
  });
  assert(readyHuge.res.status === 400, "cannot queue over-limit payload");

  await req(`/api/publish/drafts/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ statement: "hello chain" }),
    headers: { cookie },
  });

  const noConsent = await req(`/api/publish/drafts/${id}/ready`, {
    method: "POST",
    body: JSON.stringify({ consent: false }),
    headers: { cookie },
  });
  assert(noConsent.res.status === 400, "consent required");

  const ready = await req(`/api/publish/drafts/${id}/ready`, {
    method: "POST",
    body: JSON.stringify({ consent: true }),
    headers: { cookie },
  });
  assert(ready.body.draft.status === "ready", "queued after consent");
  const stillHidden = await req("/api/feed?tab=live");
  assert(!stillHidden.body.posts.some((post) => post.message === "hello chain"), "ready draft still not public");

  const imageDraft = await req("/api/publish/drafts", {
    method: "POST",
    body: JSON.stringify({ statement: "pic", kind: "both" }),
    headers: { cookie },
  });
  const fat = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(HARD_MAX + 10)]);
  const mpBad = form({
    original: { body: fat, filename: "big.jpg", type: "image/jpeg" },
    payload: { body: fat, filename: "opt.jpg", type: "image/jpeg" },
    width: "10",
    height: "10",
    mime: "image/jpeg",
  });
  const rejected = await req(`/api/publish/drafts/${imageDraft.body.draft.id}/image`, {
    method: "POST",
    body: mpBad.body,
    headers: { cookie, "content-type": mpBad.type },
    raw: true,
  });
  assert(rejected.res.status === 400, "rejects optimized image over 90k");

  const mp = form({
    original: { body: Buffer.concat([JPEG, Buffer.alloc(5000)]), filename: "orig.jpg", type: "image/jpeg" },
    payload: { body: JPEG, filename: "opt.jpg", type: "image/jpeg" },
    width: "1",
    height: "1",
    mime: "image/jpeg",
  });
  const attached = await req(`/api/publish/drafts/${imageDraft.body.draft.id}/image`, {
    method: "POST",
    body: mp.body,
    headers: { cookie, "content-type": mp.type },
    raw: true,
  });
  assert(attached.res.status === 200, "stores optimized image");
  assert(attached.body.draft.kind === "both", "text plus image");
  assert(attached.body.draft.originalBytes > attached.body.draft.byteCount, "keeps larger original");

  const limits = await req("/api/publish/limits");
  assert(limits.body.hardMax === HARD_MAX, "exposes hard max");
  assert(limits.body.paymentsEnabled === false, "payments stay off");

  console.log("instaop publish checks ok");
} finally {
  await new Promise((resolve) => app.server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
