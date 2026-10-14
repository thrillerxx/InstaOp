import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./index.mjs";
import { verifyNostrEvent, validUsername, hashPassword, verifyPassword } from "./auth.mjs";
import { IMPORT_ATTRIBUTION } from "./db.mjs";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const dir = mkdtempSync(join(tmpdir(), "instaop-social-"));
writeFileSync(join(dir, "posts.json"), JSON.stringify({
  lastSeen: 10,
  posts: {
    ev1: {
      id: "ev1",
      txid: "d8e6aaaa25d6ecbfb8cb959ffde21b9079da9341ca499854b781dd9500db4dff",
      message: "hello from the chain",
      messageKind: "text",
      bytes: 20,
      note: "A small act of permanence.",
      hashtags: ["OP_RETURN"],
      created_at: 100,
      demo: false,
      artStatus: "pending",
      artStyle: "type",
      confirmed: true,
    },
    demo1: {
      id: "demo1",
      txid: "",
      message: "fake",
      messageKind: "text",
      bytes: 4,
      note: "",
      hashtags: [],
      created_at: 200,
      demo: true,
      artStatus: "pending",
      artStyle: "type",
      confirmed: null,
    },
  },
}));

const app = createApp({ dataDir: dir, bind: "127.0.0.1", port: 0, noIngest: true, allowDemo: false });
const addr = await new Promise((resolve) => {
  app.server.listen(0, "127.0.0.1", () => resolve(app.server.address()));
});
const base = `http://127.0.0.1:${addr.port}`;

async function req(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["content-type"] && !options.form) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  return { res, body, cookie: res.headers.getSetCookie?.() || res.headers.get("set-cookie") };
}

function cookieHeader(setCookie) {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return raw ? raw.split(";")[0] : "";
}

try {
  assert(validUsername("thrillerx") === true, "username ok");
  assert(validUsername("opreturn") === false, "reserved opreturn");
  const hashed = hashPassword("correct horse");
  assert(verifyPassword("correct horse", hashed), "password verifies");
  assert(!verifyPassword("wrong", hashed), "password rejects");
  assert(verifyNostrEvent({ id: "00", pubkey: "aa", sig: "bb" }) === false, "junk nostr rejected");

  const feed = await req("/api/feed?tab=live");
  assert(feed.body.posts.length === 1, `live hides demo, got ${feed.body.posts.length}`);
  assert(feed.body.posts[0].author.username === "opreturn", "imported post owned by opreturn");
  assert(feed.body.posts[0].likeCount === 0, "no fake likes");
  assert(feed.body.posts[0].commentCount === 0, "no fake comments");
  assert(feed.body.posts[0].attribution.includes("does not identify"), "attribution present");
  assert(feed.body.posts[0].attribution === IMPORT_ATTRIBUTION, "canonical attribution");

  const guestLike = await req("/api/posts/ev1/like", { method: "POST", body: "{}" });
  assert(guestLike.res.status === 401, "guest cannot like");

  const taken = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: "opreturn", email: "a@b.com", password: "password1", displayName: "Nope" }),
  });
  assert(taken.res.status === 400, "cannot register reserved username");

  const alice = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: "alice", email: "alice@example.com", password: "password1", displayName: "Alice" }),
  });
  assert(alice.res.status === 201, "alice registers");
  const aliceCookie = cookieHeader(alice.cookie);
  assert(aliceCookie.startsWith("io_sid="), "session cookie set");

  const bob = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: "bob", email: "bob@example.com", password: "password1", displayName: "Bob" }),
  });
  const bobCookie = cookieHeader(bob.cookie);

  const home = await req("/api/feed?tab=home", { headers: { cookie: aliceCookie } });
  assert(home.body.posts.some((p) => p.author.username === "opreturn"), "new users follow opreturn");

  const liked = await req("/api/posts/ev1/like", { method: "POST", body: "{}", headers: { cookie: aliceCookie } });
  assert(liked.body.likeCount === 1 && liked.body.liked === true, "alice like counts");

  const again = await req("/api/posts/ev1/like", { method: "POST", body: "{}", headers: { cookie: aliceCookie } });
  assert(again.body.likeCount === 1, "duplicate like does not inflate");

  const commented = await req("/api/posts/ev1/comments", {
    method: "POST",
    body: JSON.stringify({ body: "forever @bob" }),
    headers: { cookie: aliceCookie },
  });
  assert(commented.body.commentCount === 1, "comment count is real");
  const commentId = commented.body.comments[0].id;

  const steal = await req(`/api/comments/${commentId}`, { method: "DELETE", headers: { cookie: bobCookie } });
  assert(steal.res.status === 403, "bob cannot delete alice comment");

  const own = await req(`/api/comments/${commentId}`, { method: "DELETE", headers: { cookie: aliceCookie } });
  assert(own.res.status === 200, "alice can delete her comment");

  const bobNotes = await req("/api/notifications", { headers: { cookie: bobCookie } });
  assert(bobNotes.body.items.some((n) => n.kind === "mention"), "mention notifies bob");

  await req("/api/users/bob/follow", { method: "POST", body: "{}", headers: { cookie: aliceCookie } });
  const bobProfile = await req("/api/users/bob", { headers: { cookie: aliceCookie } });
  assert(bobProfile.body.user.viewerFollows === true, "follow works");
  assert(bobProfile.body.user.followerCount === 1, "follower count");

  const editBob = await req("/api/me", {
    method: "PATCH",
    body: JSON.stringify({ bio: "hacked" }),
    headers: { cookie: aliceCookie },
  });
  assert(editBob.body.user.username === "alice", "patch only edits self");
  const bobStill = await req("/api/users/bob");
  assert(bobStill.body.user.bio !== "hacked", "cannot edit another profile");

  const publish = await req("/api/publish", { method: "POST", body: "{}", headers: { cookie: aliceCookie } });
  assert(publish.res.status === 403, "no offchain public posts");

  const demo = await req("/api/demo", { method: "POST", body: "{}" });
  assert(demo.res.status === 403, "demo disabled");

  const challenge = await req("/api/auth/nostr/challenge");
  const badNostr = await req("/api/auth/nostr", {
    method: "POST",
    body: JSON.stringify({
      challenge: challenge.body.challenge,
      event: { id: "0".repeat(64), pubkey: "1".repeat(64), sig: "2".repeat(128), created_at: 1, kind: 1, tags: [], content: "x" },
    }),
  });
  assert(badNostr.res.status === 401 || badNostr.res.status === 400, "unsigned nostr rejected");

  const deleted = await req("/api/me", { method: "DELETE", headers: { cookie: aliceCookie } });
  assert(deleted.body.notice.includes("cannot be deleted"), "delete warns onchain remains");
  const gone = await req("/api/users/alice");
  assert(gone.res.status === 404, "deleted username is gone");

  console.log("instaop social checks ok");
} finally {
  await new Promise((resolve) => app.server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
