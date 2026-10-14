import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const SCHEMA_VERSION = 3;
export const STORY_TTL_SEC = 24 * 60 * 60;
export const OPRETURN_USERNAME = "OP_RETURN_Bot";
export const OPRETURN_PUBLISHER = "OP_RETURN Bo";
export const OPRETURN_WEBSITE = "https://opreturnbot.com";
export const OPRETURN_ALIASES = ["opreturn", "op_return", "op_return_bot", "op_returnbot"];

export function isOfficialUsername(value) {
  const key = String(value || "").trim().toLowerCase();
  return key === OPRETURN_USERNAME.toLowerCase() || OPRETURN_ALIASES.includes(key);
}
export const IMPORT_ATTRIBUTION =
  "Imported from the public OP_RETURN Bot feed. OP_RETURN Bot published this through InstaOp. A Bitcoin transaction does not identify who wrote the original message.";

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    email TEXT UNIQUE,
    password_hash TEXT,
    bio TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    avatar_path TEXT,
    is_system INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS identities (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(kind, value)
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS nostr_challenges (
    id TEXT PRIMARY KEY,
    nonce TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS follows (
    follower_id TEXT NOT NULL REFERENCES users(id),
    followee_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (follower_id, followee_id)
  )`,
  `CREATE TABLE IF NOT EXISTS blocks (
    blocker_id TEXT NOT NULL REFERENCES users(id),
    blocked_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  )`,
  `CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    author_id TEXT NOT NULL REFERENCES users(id),
    source TEXT NOT NULL,
    attribution TEXT,
    txid TEXT,
    created_at INTEGER NOT NULL,
    hidden_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS likes (
    user_id TEXT NOT NULL REFERENCES users(id),
    post_id TEXT NOT NULL REFERENCES posts(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, post_id)
  )`,
  `CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES posts(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    parent_id TEXT REFERENCES comments(id),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS bookmarks (
    user_id TEXT NOT NULL REFERENCES users(id),
    post_id TEXT NOT NULL REFERENCES posts(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, post_id)
  )`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    actor_id TEXT REFERENCES users(id),
    kind TEXT NOT NULL,
    post_id TEXT,
    comment_id TEXT,
    read_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    reporter_id TEXT NOT NULL REFERENCES users(id),
    post_id TEXT,
    target_user_id TEXT,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS publication_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    post_id TEXT,
    status TEXT NOT NULL,
    payload_kind TEXT NOT NULL,
    payload_hash TEXT,
    byte_count INTEGER,
    r_hash TEXT,
    invoice TEXT,
    amount_msat INTEGER,
    txid TEXT,
    confirmed INTEGER,
    idempotency_key TEXT UNIQUE,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS moderation_actions (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL REFERENCES users(id),
    target_user_id TEXT,
    target_post_id TEXT,
    kind TEXT NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pub_user ON publication_requests(user_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS comment_likes (
    user_id TEXT NOT NULL REFERENCES users(id),
    comment_id TEXT NOT NULL REFERENCES comments(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, comment_id)
  )`,
  `CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    image_path TEXT NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_comment_likes_comment ON comment_likes(comment_id)`,
  `CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories(expires_at, created_at DESC)`,
];

const EXTRA_COLUMNS = [
  ["publication_requests", "statement", "TEXT NOT NULL DEFAULT ''"],
  ["publication_requests", "caption", "TEXT NOT NULL DEFAULT ''"],
  ["publication_requests", "hashtags", "TEXT NOT NULL DEFAULT '[]'"],
  ["publication_requests", "payload_path", "TEXT"],
  ["publication_requests", "original_path", "TEXT"],
  ["publication_requests", "mime", "TEXT"],
  ["publication_requests", "width", "INTEGER"],
  ["publication_requests", "height", "INTEGER"],
  ["publication_requests", "original_bytes", "INTEGER"],
  ["publication_requests", "consent", "INTEGER NOT NULL DEFAULT 0"],
  ["publication_requests", "no_twitter", "INTEGER NOT NULL DEFAULT 1"],
  ["publication_requests", "invoice_expires_at", "INTEGER"],
  ["publication_requests", "amount_btc", "TEXT"],
  ["users", "website", "TEXT NOT NULL DEFAULT ''"],
];

function ensureColumn(db, table, name, spec) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((col) => col.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${spec}`);
  }
}

export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "avatars"), { recursive: true });
  mkdirSync(join(dataDir, "images"), { recursive: true });
  mkdirSync(join(dataDir, "drafts"), { recursive: true });
  mkdirSync(join(dataDir, "stories"), { recursive: true });
  const db = new Database(join(dataDir, "social.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const migrate = db.transaction(() => {
    for (const sql of MIGRATIONS) db.exec(sql);
    for (const [table, name, spec] of EXTRA_COLUMNS) ensureColumn(db, table, name, spec);
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
  });
  migrate();
  return db;
}
