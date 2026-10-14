import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function createStore(dataDir) {
  mkdirSync(join(dataDir, "images"), { recursive: true });
  const file = join(dataDir, "posts.json");

  let state = { posts: {}, lastSeen: 0 };
  if (existsSync(file)) {
    try {
      state = JSON.parse(readFileSync(file, "utf8"));
      if (!state.posts) state.posts = {};
    } catch {
      state = { posts: {}, lastSeen: 0 };
    }
  }

  function persist() {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, file);
  }

  return {
    dataDir,
    imagePath(id) {
      const base = join(dataDir, "images", safeId(id));
      for (const ext of [".webp", ".jpg", ".jpeg", ".png", ".svg"]) {
        if (existsSync(base + ext)) return base + ext;
      }
      return `${base}.svg`;
    },
    writeImage(id, buffer, ext = ".svg") {
      const dest = join(dataDir, "images", `${safeId(id)}${ext}`);
      writeFileSync(dest, buffer);
      return dest;
    },
    get(id) {
      return state.posts[id] || null;
    },
    byTxid(txid) {
      if (!txid) return null;
      return Object.values(state.posts).find((post) => post.txid === txid) || null;
    },
    all() {
      return Object.values(state.posts).sort((a, b) => b.created_at - a.created_at);
    },
    lastSeen() {
      const real = Object.values(state.posts).filter((post) => !post.demo);
      if (!real.length) return 0;
      return Math.max(...real.map((post) => post.created_at || 0));
    },
    touchSeen() {},
    upsert(post) {
      const existing = state.posts[post.id] || (post.txid ? this.byTxid(post.txid) : null);
      if (existing && existing.id !== post.id) return { post: existing, created: false };
      if (existing) return { post: existing, created: false };
      state.posts[post.id] = post;
      persist();
      return { post, created: true };
    },
    update(id, patch) {
      const current = state.posts[id];
      if (!current) return null;
      state.posts[id] = { ...current, ...patch };
      persist();
      return state.posts[id];
    },
    pendingArt() {
      return this.all().filter((post) => post.artStatus !== "ready" || !existsSync(this.imagePath(post.id)));
    },
  };
}

export function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80) || "unknown";
}

export function publicPost(post, store) {
  const ready = post.artStatus === "ready" && existsSync(store.imagePath(post.id));
  return {
    id: post.id,
    txid: post.txid || "",
    message: post.message,
    messageKind: post.messageKind,
    note: post.note,
    hashtags: post.hashtags,
    bytes: post.bytes,
    created_at: post.created_at,
    demo: Boolean(post.demo),
    artStatus: ready ? "ready" : post.artStatus,
    artStyle: post.artStyle,
    imageUrl: ready ? `/media/${encodeURIComponent(post.id)}` : null,
    confirmed: post.confirmed ?? null,
  };
}
