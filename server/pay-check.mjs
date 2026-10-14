import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./index.mjs";
import { createMockBot } from "./opreturn.mjs";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const dir = mkdtempSync(join(tmpdir(), "instaop-pay-"));
writeFileSync(join(dir, "posts.json"), JSON.stringify({ lastSeen: 0, posts: {} }));
const mock = createMockBot();
const confirmed = new Map();
const app = createApp({
  dataDir: dir,
  bind: "127.0.0.1",
  port: 0,
  noIngest: true,
  paymentsEnabled: true,
  bot: mock,
  lookupConfirmed: async (txid) => confirmed.get(txid) ?? false,
});
const addr = await new Promise((resolve) => app.server.listen(0, "127.0.0.1", () => resolve(app.server.address())));
const base = `http://127.0.0.1:${addr.port}`;

async function req(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  const set = res.headers.getSetCookie?.() || res.headers.get("set-cookie");
  return { res, body, cookie: Array.isArray(set) ? set[0] : set };
}

function sid(setCookie) {
  return setCookie ? setCookie.split(";")[0] : "";
}

try {
  const offDir = mkdtempSync(join(tmpdir(), "instaop-payoff-"));
  writeFileSync(join(offDir, "posts.json"), JSON.stringify({ lastSeen: 0, posts: {} }));
  const off = createApp({ dataDir: offDir, bind: "127.0.0.1", port: 0, noIngest: true, paymentsEnabled: false });
  const offAddr = await new Promise((resolve) => off.server.listen(0, "127.0.0.1", () => resolve(off.server.address())));
  const offBase = `http://127.0.0.1:${offAddr.port}`;
  const blocked = await fetch(`${offBase}/api/publish/pay`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  assert(blocked.status === 403, "payments off stays 403");
  await new Promise((resolve) => off.server.close(resolve));
  rmSync(offDir, { recursive: true, force: true });

  const user = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: "payer", email: "payer@example.com", password: "password1", displayName: "Payer" }),
  });
  const cookie = sid(user.cookie);
  const created = await req("/api/publish/drafts", {
    method: "POST",
    body: JSON.stringify({ statement: "hello bitcoin" }),
    headers: { cookie },
  });
  const id = created.body.draft.id;
  await req(`/api/publish/drafts/${id}/ready`, {
    method: "POST",
    body: JSON.stringify({ consent: true }),
    headers: { cookie },
  });

  const first = await req(`/api/publish/drafts/${id}/pay`, { method: "POST", body: "{}", headers: { cookie } });
  assert(first.res.status === 200, "pay creates invoice");
  assert(first.body.draft.status === "pending_payment", "pending payment");
  assert(first.body.draft.invoice.startsWith("lnbc"), "real-looking invoice from mock");
  assert(mock.invoices.size === 1, "one bot invoice");
  const rHash = first.body.draft.rHash;

  const second = await req(`/api/publish/drafts/${id}/pay`, { method: "POST", body: "{}", headers: { cookie } });
  assert(second.body.reused === true, "does not create a second invoice");
  assert(mock.invoices.size === 1, "still one invoice");

  const unpaid = await req(`/api/publish/drafts/${id}/refresh`, { method: "POST", body: "{}", headers: { cookie } });
  assert(unpaid.body.draft.status === "pending_payment", "unpaid stays pending");

  mock.pay(rHash);
  const paid = await req(`/api/publish/drafts/${id}/refresh`, { method: "POST", body: "{}", headers: { cookie } });
  assert(paid.body.draft.status === "paid", "paid but not broadcast");
  const hiddenPaid = await req("/api/feed?tab=live");
  assert(!hiddenPaid.body.posts.some((post) => post.message === "hello bitcoin"), "paid is not public");

  const txid = "ab".repeat(32);
  mock.broadcast(rHash, txid);
  const broadcast = await req(`/api/publish/drafts/${id}/refresh`, { method: "POST", body: "{}", headers: { cookie } });
  assert(broadcast.body.draft.status === "broadcast", "broadcast waits for confirmation");
  const hiddenBcast = await req("/api/feed?tab=live");
  assert(!hiddenBcast.body.posts.some((post) => post.message === "hello bitcoin"), "broadcast is not public");

  confirmed.set(txid, true);
  const done = await req(`/api/publish/drafts/${id}/refresh`, { method: "POST", body: "{}", headers: { cookie } });
  assert(done.body.draft.status === "confirmed", "confirmed after mempool yes");
  const live = await req("/api/feed?tab=live");
  const post = live.body.posts.find((item) => item.message === "hello bitcoin");
  assert(post, "confirmed post enters the public feed");
  assert(post.author.username === "payer", "author is the paying user");
  assert(post.txid === txid, "txid stored");
  assert(post.source === "user_publish", "not attributed as an imported bot note");

  console.log("instaop pay checks ok");
} finally {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
