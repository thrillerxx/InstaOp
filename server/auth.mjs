import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";

function bytesToHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function hexToBytes(hex) {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

const SCRYPT = { N: 16384, r: 8, p: 1 };
export const SESSION_DAYS = 30;
export const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;
export const RESERVED = new Set([
  "opreturn",
  "admin",
  "instaop",
  "instagram",
  "you",
  "me",
  "api",
  "settings",
  "explore",
  "live",
  "support",
  "root",
]);

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function newId() {
  return randomBytes(16).toString("hex");
}

export function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

export function validUsername(value) {
  return /^[a-z0-9._]{3,24}$/.test(value) && !RESERVED.has(value);
}

export function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 160;
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [algo, saltHex, hashHex] = String(stored).split("$");
  if (algo !== "scrypt" || !saltHex || !hashHex) return false;
  const hash = scryptSync(password, Buffer.from(saltHex, "hex"), 32, SCRYPT);
  const expected = Buffer.from(hashHex, "hex");
  if (hash.length !== expected.length) return false;
  return timingSafeEqual(hash, expected);
}

export function serializeNostrEvent(event) {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags || [],
    event.content,
  ]);
}

export function nostrEventId(event) {
  return createHash("sha256").update(serializeNostrEvent(event)).digest("hex");
}

export function verifyNostrEvent(event) {
  try {
    if (!event?.id || !event.pubkey || !event.sig) return false;
    if (!/^[0-9a-f]{64}$/i.test(event.pubkey) || !/^[0-9a-f]{128}$/i.test(event.sig)) return false;
    if (nostrEventId(event) !== event.id) return false;
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}

export function challengeSatisfied(event, nonce) {
  if (!event) return false;
  const age = Math.abs(nowSec() - Number(event.created_at || 0));
  if (age > 10 * 60) return false;
  const tags = Array.isArray(event.tags) ? event.tags : [];
  const tagged = tags.some((tag) => tag[0] === "challenge" && tag[1] === nonce);
  const contentOk = String(event.content || "").includes(nonce);
  return tagged || contentOk;
}

export function createAuth(db) {
  const insertUser = db.prepare(`
    INSERT INTO users(id, username, display_name, email, password_hash, bio, city, avatar_path, is_system, created_at, updated_at)
    VALUES (@id, @username, @display_name, @email, @password_hash, @bio, @city, @avatar_path, @is_system, @created_at, @updated_at)
  `);
  const insertIdentity = db.prepare(`
    INSERT INTO identities(id, user_id, kind, value, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertSession = db.prepare(`
    INSERT INTO sessions(id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)
  `);
  const deleteSession = db.prepare(`DELETE FROM sessions WHERE id = ?`);
  const purgeExpired = db.prepare(`DELETE FROM sessions WHERE expires_at < ?`);
  const getSession = db.prepare(`
    SELECT s.id AS session_id, s.expires_at, u.*
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `);
  const byUsername = db.prepare(`SELECT * FROM users WHERE username = ?`);
  const byEmail = db.prepare(`SELECT * FROM users WHERE email = ?`);
  const byId = db.prepare(`SELECT * FROM users WHERE id = ?`);
  const byNostr = db.prepare(`
    SELECT u.* FROM identities i JOIN users u ON u.id = i.user_id
    WHERE i.kind = 'nostr' AND i.value = ?
  `);
  const insertChallenge = db.prepare(`
    INSERT INTO nostr_challenges(id, nonce, created_at, expires_at) VALUES (?, ?, ?, ?)
  `);
  const getChallenge = db.prepare(`SELECT * FROM nostr_challenges WHERE nonce = ?`);
  const useChallenge = db.prepare(`UPDATE nostr_challenges SET used_at = ? WHERE nonce = ? AND used_at IS NULL`);

  function publicUser(user) {
    if (!user || user.deleted_at) return null;
    return {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      bio: user.bio || "",
      city: user.city || "",
      avatarUrl: user.avatar_path ? `/media/avatar/${user.id}` : `/media/avatar/${user.username}`,
      isSystem: Boolean(user.is_system),
      createdAt: user.created_at,
    };
  }

  function issueSession(userId) {
    purgeExpired.run(nowSec());
    const token = randomBytes(24).toString("hex");
    const created = nowSec();
    insertSession.run(token, userId, created, created + SESSION_SECONDS);
    return token;
  }

  function userFromSession(token) {
    if (!token) return null;
    const row = getSession.get(token);
    if (!row || row.expires_at < nowSec() || row.deleted_at) return null;
    return row;
  }

  const registerTx = db.transaction(({ username, email, password, displayName }) => {
    const uname = normalizeUsername(username);
    if (!validUsername(uname)) throw Object.assign(new Error("Choose a username with 3–24 letters, numbers, dots, or underscores."), { status: 400 });
    if (!validEmail(email)) throw Object.assign(new Error("Enter a valid email."), { status: 400 });
    if (String(password || "").length < 8) throw Object.assign(new Error("Password must be at least 8 characters."), { status: 400 });
    if (byUsername.get(uname) || byEmail.get(email.toLowerCase())) {
      throw Object.assign(new Error("That username or email is already taken."), { status: 409 });
    }
    const id = newId();
    const created = nowSec();
    insertUser.run({
      id,
      username: uname,
      display_name: String(displayName || uname).slice(0, 40),
      email: email.toLowerCase(),
      password_hash: hashPassword(password),
      bio: "",
      city: "",
      avatar_path: null,
      is_system: 0,
      created_at: created,
      updated_at: created,
    });
    insertIdentity.run(newId(), id, "email", email.toLowerCase(), created);
    return byId.get(id);
  });

  const nostrLoginTx = db.transaction((event, nonce) => {
    const challenge = getChallenge.get(nonce);
    if (!challenge || challenge.used_at || challenge.expires_at < nowSec()) {
      throw Object.assign(new Error("That login challenge expired. Try again."), { status: 400 });
    }
    if (!verifyNostrEvent(event) || !challengeSatisfied(event, nonce)) {
      throw Object.assign(new Error("Could not verify the Nostr signature."), { status: 401 });
    }
    const used = useChallenge.run(nowSec(), nonce);
    if (!used.changes) throw Object.assign(new Error("That login challenge was already used."), { status: 400 });
    const pubkey = String(event.pubkey).toLowerCase();
    let user = byNostr.get(pubkey);
    if (!user) {
      let username = `npub${pubkey.slice(0, 8)}`;
      let n = 0;
      while (byUsername.get(username) || RESERVED.has(username)) {
        n += 1;
        username = `npub${pubkey.slice(0, 8)}${n}`;
      }
      const id = newId();
      const created = nowSec();
      insertUser.run({
        id,
        username,
        display_name: username,
        email: null,
        password_hash: null,
        bio: "",
        city: "",
        avatar_path: null,
        is_system: 0,
        created_at: created,
        updated_at: created,
      });
      insertIdentity.run(newId(), id, "nostr", pubkey, created);
      user = byId.get(id);
    }
    return user;
  });

  return {
    publicUser,
    issueSession,
    userFromSession,
    clearSession(token) {
      if (token) deleteSession.run(token);
    },
    register(input) {
      return registerTx(input);
    },
    login(identifier, password) {
      const key = String(identifier || "").trim().toLowerCase();
      const user = key.includes("@") ? byEmail.get(key) : byUsername.get(key);
      if (!user || user.deleted_at || !verifyPassword(password, user.password_hash)) {
        throw Object.assign(new Error("Wrong email, username, or password."), { status: 401 });
      }
      return user;
    },
    issueChallenge() {
      const nonce = randomBytes(16).toString("hex");
      const created = nowSec();
      insertChallenge.run(newId(), nonce, created, created + 5 * 60);
      return { challenge: nonce, expiresAt: created + 5 * 60 };
    },
    loginNostr(event, nonce) {
      return nostrLoginTx(event, nonce);
    },
    getUser(id) {
      return byId.get(id) || null;
    },
    getByUsername(username) {
      return byUsername.get(normalizeUsername(username)) || null;
    },
  };
}
