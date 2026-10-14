import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { IMPORT_ATTRIBUTION, isOfficialUsername, OPRETURN_PUBLISHER, OPRETURN_USERNAME, OPRETURN_WEBSITE } from "./db.mjs";
import { newId, nowSec, normalizeUsername } from "./auth.mjs";

const MENTION_RE = /@([a-zA-Z0-9._]{3,24})/g;
const AVATAR_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function avatarSvg(seed, label) {
  const colors = ["#f7931a", "#ee2a7b", "#6228d7", "#0095f6", "#00d26a", "#405de6"];
  let h = 2166136261;
  for (const ch of String(seed)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  const color = colors[(h >>> 0) % colors.length];
  const letter = escapeXml((label || seed || "?").slice(0, 1).toUpperCase());
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="${color}"/><text x="32" y="41" text-anchor="middle" font-size="28" fill="#fff" font-family="Inter, system-ui, sans-serif">${letter}</text></svg>`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function parseWebsite(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.length > 200) throw Object.assign(new Error("Website is too long."), { status: 400 });
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw Object.assign(new Error("Enter a valid website."), { status: 400 });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw Object.assign(new Error("Website must be http or https."), { status: 400 });
  }
  if (!url.hostname || url.username || url.password) {
    throw Object.assign(new Error("Enter a valid website."), { status: 400 });
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    throw Object.assign(new Error("Enter a valid website."), { status: 400 });
  }
  return url.href.replace(/\/$/, "");
}

export function createSocial(db, { dataDir, auth }) {
  mkdirSync(join(dataDir, "avatars"), { recursive: true });

  const insertUser = db.prepare(`
    INSERT INTO users(id, username, display_name, email, password_hash, bio, city, avatar_path, is_system, created_at, updated_at)
    VALUES (@id, @username, @display_name, @email, @password_hash, @bio, @city, @avatar_path, @is_system, @created_at, @updated_at)
  `);
  const getUser = db.prepare(`SELECT * FROM users WHERE id = ?`);
  const getByUsername = db.prepare(`SELECT * FROM users WHERE lower(username) = ?`);
  const getOfficialRow = db.prepare(`SELECT * FROM users WHERE id = 'user_opreturn' OR is_system = 1 ORDER BY created_at ASC`);
  const listUsers = db.prepare(`SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 40`);
  const activeUserIds = db.prepare(`SELECT id FROM users WHERE deleted_at IS NULL`);
  const updateUser = db.prepare(`
    UPDATE users SET display_name = @display_name, bio = @bio, city = @city, website = @website, avatar_path = @avatar_path, updated_at = @updated_at
    WHERE id = @id
  `);
  const softDelete = db.prepare(`
    UPDATE users SET username = @username, email = NULL, password_hash = NULL, display_name = 'Deleted account',
      bio = '', city = '', website = '', avatar_path = NULL, deleted_at = @deleted_at, updated_at = @deleted_at
    WHERE id = @id
  `);
  const deleteIdentities = db.prepare(`DELETE FROM identities WHERE user_id = ?`);
  const deleteSessions = db.prepare(`DELETE FROM sessions WHERE user_id = ?`);
  const insertFollow = db.prepare(`INSERT OR IGNORE INTO follows(follower_id, followee_id, created_at) VALUES (?, ?, ?)`);
  const deleteFollow = db.prepare(`DELETE FROM follows WHERE follower_id = ? AND followee_id = ?`);
  const isFollowing = db.prepare(`SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?`);
  const followerCount = db.prepare(`SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?`);
  const followingCount = db.prepare(`SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?`);
  const suggest = db.prepare(`
    SELECT u.* FROM users u
    WHERE u.deleted_at IS NULL AND u.id != ? AND u.id NOT IN (SELECT followee_id FROM follows WHERE follower_id = ?)
    ORDER BY u.is_system DESC, u.created_at ASC
    LIMIT 8
  `);
  const upsertPost = db.prepare(`
    INSERT INTO posts(id, author_id, source, attribution, txid, created_at)
    VALUES (@id, @author_id, @source, @attribution, @txid, @created_at)
    ON CONFLICT(id) DO UPDATE SET txid = COALESCE(excluded.txid, posts.txid)
  `);
  const getPost = db.prepare(`SELECT * FROM posts WHERE id = ?`);
  const like = db.prepare(`INSERT OR IGNORE INTO likes(user_id, post_id, created_at) VALUES (?, ?, ?)`);
  const unlike = db.prepare(`DELETE FROM likes WHERE user_id = ? AND post_id = ?`);
  const liked = db.prepare(`SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?`);
  const likeCount = db.prepare(`SELECT COUNT(*) AS n FROM likes WHERE post_id = ?`);
  const insertComment = db.prepare(`
    INSERT INTO comments(id, post_id, user_id, parent_id, body, created_at)
    VALUES (@id, @post_id, @user_id, @parent_id, @body, @created_at)
  `);
  const getComment = db.prepare(`SELECT * FROM comments WHERE id = ?`);
  const listComments = db.prepare(`
    SELECT c.*, u.username, u.display_name, u.avatar_path, u.deleted_at
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.post_id = ? AND c.deleted_at IS NULL
    ORDER BY c.created_at ASC
    LIMIT 80
  `);
  const commentCount = db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE post_id = ? AND deleted_at IS NULL`);
  const hideComment = db.prepare(`UPDATE comments SET deleted_at = ? WHERE id = ?`);
  const bookmark = db.prepare(`INSERT OR IGNORE INTO bookmarks(user_id, post_id, created_at) VALUES (?, ?, ?)`);
  const unbookmark = db.prepare(`DELETE FROM bookmarks WHERE user_id = ? AND post_id = ?`);
  const booked = db.prepare(`SELECT 1 FROM bookmarks WHERE user_id = ? AND post_id = ?`);
  const savedIds = db.prepare(`SELECT post_id FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC`);
  const notify = db.prepare(`
    INSERT INTO notifications(id, user_id, actor_id, kind, post_id, comment_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const listNotes = db.prepare(`
    SELECT n.*, a.username AS actor_username, a.display_name AS actor_display
    FROM notifications n LEFT JOIN users a ON a.id = n.actor_id
    WHERE n.user_id = ?
    ORDER BY n.created_at DESC
    LIMIT 40
  `);
  const unreadCount = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL`);
  const markRead = db.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL`);
  const followingIds = db.prepare(`SELECT followee_id FROM follows WHERE follower_id = ?`);
  const listFollowers = db.prepare(`
    SELECT u.* FROM follows f JOIN users u ON u.id = f.follower_id
    WHERE f.followee_id = ? AND u.deleted_at IS NULL
    ORDER BY f.created_at DESC
    LIMIT 80
  `);
  const listFollowing = db.prepare(`
    SELECT u.* FROM follows f JOIN users u ON u.id = f.followee_id
    WHERE f.follower_id = ? AND u.deleted_at IS NULL
    ORDER BY f.created_at DESC
    LIMIT 80
  `);
  const report = db.prepare(`
    INSERT INTO reports(id, reporter_id, post_id, target_user_id, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const block = db.prepare(`INSERT OR IGNORE INTO blocks(blocker_id, blocked_id, created_at) VALUES (?, ?, ?)`);
  const blockedSet = db.prepare(`SELECT blocked_id FROM blocks WHERE blocker_id = ?`);

  function findByUsername(username) {
    const key = normalizeUsername(username);
    if (isOfficialUsername(key)) {
      return getUser.get("user_opreturn") || getOfficialRow.get() || getByUsername.get(OPRETURN_USERNAME.toLowerCase()) || null;
    }
    return getByUsername.get(key) || null;
  }

  function publicUser(user, viewerId = null) {
    const base = auth.publicUser(user);
    if (!base) return null;
    return {
      ...base,
      followerCount: followerCount.get(user.id).n,
      followingCount: followingCount.get(user.id).n,
      viewerFollows: viewerId ? Boolean(isFollowing.get(viewerId, user.id)) : false,
    };
  }

  function seedOfficial() {
    const existing = getUser.get("user_opreturn") || getOfficialRow.get() || findByUsername(OPRETURN_USERNAME) || findByUsername("opreturn");
    const created = nowSec();
    const id = existing?.id || "user_opreturn";
    if (!existing) {
      insertUser.run({
        id,
        username: OPRETURN_USERNAME,
        display_name: OPRETURN_PUBLISHER,
        email: null,
        password_hash: null,
        bio: "Official InstaOp publisher. Public OP_RETURN Bot messages land here. A Bitcoin transaction does not identify its author.",
        city: "Bitcoin mainnet",
        avatar_path: null,
        is_system: 1,
        created_at: created,
        updated_at: created,
      });
    } else if (existing.username !== OPRETURN_USERNAME) {
      db.prepare(`UPDATE users SET username = ? WHERE id = ?`).run(OPRETURN_USERNAME, id);
    }
    const user = getUser.get(id);
    updateUser.run({
      id,
      display_name: OPRETURN_PUBLISHER,
      bio: user.bio,
      city: user.city || "Bitcoin mainnet",
      website: OPRETURN_WEBSITE,
      avatar_path: user.avatar_path,
      updated_at: created,
    });
    return getUser.get(id);
  }

  function official() {
    return seedOfficial();
  }

  function followOfficial(userId) {
    const bot = official();
    if (userId && userId !== bot.id) insertFollow.run(userId, bot.id, nowSec());
  }

  function ensureEveryoneFollowsOfficial() {
    const bot = official();
    for (const row of activeUserIds.all()) followOfficial(row.id);
    return bot;
  }

  function importPost(post) {
    if (!post?.id || post.demo) return null;
    const existing = getPost.get(post.id);
    if (existing) return existing;
    const bot = official();
    upsertPost.run({
      id: post.id,
      author_id: bot.id,
      source: "opreturn_bot_import",
      attribution: IMPORT_ATTRIBUTION,
      txid: post.txid || "",
      created_at: post.created_at || nowSec(),
    });
    return getPost.get(post.id);
  }

  function claimUserPost({ id, userId, txid, createdAt }) {
    const user = getUser.get(userId);
    if (!user || user.deleted_at) throw Object.assign(new Error("Account not found."), { status: 404 });
    const existing = getPost.get(id);
    if (existing && existing.author_id !== userId) {
      throw Object.assign(new Error("That onchain post is already claimed."), { status: 409 });
    }
    upsertPost.run({
      id,
      author_id: userId,
      source: "user_publish",
      attribution: `Published by @${user.username} through InstaOp. OP_RETURN Bot wrote the bytes. A Bitcoin transaction does not by itself prove authorship.`,
      txid: txid || "",
      created_at: createdAt || nowSec(),
    });
    return getPost.get(id);
  }

  function requirePost(postId) {
    const row = getPost.get(postId);
    if (!row || row.hidden_at) throw Object.assign(new Error("Post not found."), { status: 404 });
    return row;
  }

  function mentionUsernames(body) {
    return [...String(body).matchAll(MENTION_RE)].map((m) => m[1]);
  }

  function notifyUser(userId, actorId, kind, postId, commentId) {
    if (!userId || userId === actorId) return;
    notify.run(newId(), userId, actorId, kind, postId || null, commentId || null, nowSec());
  }

  const registerAndFollow = db.transaction((input) => {
    const user = auth.register(input);
    followOfficial(user.id);
    return user;
  });

  const nostrAndFollow = db.transaction((event, nonce) => {
    const user = auth.loginNostr(event, nonce);
    followOfficial(user.id);
    return user;
  });

  return {
    official,
    followOfficial,
    ensureEveryoneFollowsOfficial,
    isOfficialImport(postId) {
      const row = getPost.get(postId);
      if (!row) return true;
      return row.source === "opreturn_bot_import";
    },
    publicUser,
    importPost,
    claimUserPost,
    register(input) {
      return registerAndFollow(input);
    },
    loginNostr(event, nonce) {
      return nostrAndFollow(event, nonce);
    },
    profile(username, viewerId) {
      const user = findByUsername(username);
      if (!user || user.deleted_at) return null;
      return publicUser(user, viewerId);
    },
    followers(username, viewerId) {
      const user = findByUsername(username);
      if (!user || user.deleted_at) return null;
      return listFollowers.all(user.id).map((row) => publicUser(row, viewerId));
    },
    following(username, viewerId) {
      const user = findByUsername(username);
      if (!user || user.deleted_at) return null;
      return listFollowing.all(user.id).map((row) => publicUser(row, viewerId));
    },
    listSuggested(viewerId) {
      const rows = viewerId ? suggest.all(viewerId, viewerId) : listUsers.all().filter((u) => !u.is_system).slice(0, 8);
      return rows.filter((u) => !isOfficialUsername(u.username) || viewerId).map((u) => publicUser(u, viewerId));
    },
    follow(viewerId, username) {
      const target = findByUsername(username);
      if (!target || target.deleted_at) throw Object.assign(new Error("Account not found."), { status: 404 });
      if (target.id === viewerId) throw Object.assign(new Error("You cannot follow yourself."), { status: 400 });
      const added = insertFollow.run(viewerId, target.id, nowSec());
      if (added.changes) notifyUser(target.id, viewerId, "follow", null, null);
      return publicUser(target, viewerId);
    },
    unfollow(viewerId, username) {
      const target = findByUsername(username);
      if (!target) throw Object.assign(new Error("Account not found."), { status: 404 });
      if (target.is_system || isOfficialUsername(target.username)) {
        followOfficial(viewerId);
        throw Object.assign(new Error("Everyone follows OP_RETURN Bot. That account stays on Home and Live."), { status: 400 });
      }
      deleteFollow.run(viewerId, target.id);
      return publicUser(target, viewerId);
    },
    updateProfile(userId, patch) {
      const user = getUser.get(userId);
      if (!user || user.deleted_at) throw Object.assign(new Error("Account not found."), { status: 404 });
      if (user.is_system) throw Object.assign(new Error("The official account cannot be edited here."), { status: 403 });
      updateUser.run({
        id: userId,
        display_name: String(patch.displayName ?? user.display_name).slice(0, 40),
        bio: String(patch.bio ?? user.bio).slice(0, 160),
        city: String(patch.city ?? user.city).slice(0, 40),
        website: parseWebsite(patch.website ?? user.website),
        avatar_path: user.avatar_path,
        updated_at: nowSec(),
      });
      return publicUser(getUser.get(userId), userId);
    },
    async saveAvatar(userId, file) {
      const user = getUser.get(userId);
      if (!user || user.is_system) throw Object.assign(new Error("Cannot change that photo."), { status: 403 });
      const ext = AVATAR_TYPES[file.type];
      if (!ext) throw Object.assign(new Error("Use a JPEG, PNG, or WebP photo."), { status: 400 });
      if (file.body.length > 2_000_000) throw Object.assign(new Error("Photo must be under 2 MB."), { status: 400 });
      const rel = `${userId}.${ext}`;
      const dest = join(dataDir, "avatars", rel);
      await pipeline(Readable.from(file.body), createWriteStream(dest));
      updateUser.run({
        id: userId,
        display_name: user.display_name,
        bio: user.bio,
        city: user.city,
        website: user.website || "",
        avatar_path: rel,
        updated_at: nowSec(),
      });
      return publicUser(getUser.get(userId), userId);
    },
    avatarFile(idOrName) {
      const user = getUser.get(idOrName) || findByUsername(idOrName);
      if (!user || user.deleted_at) return null;
      if (user.avatar_path) {
        const file = join(dataDir, "avatars", user.avatar_path);
        if (existsSync(file)) return { file, type: extType(user.avatar_path) };
      }
      if (isOfficialUsername(user.username)) {
        const logo = join(dataDir, "..", "public", "logo.svg");
        // logo lives in the app public dir; caller can fall back
        return { svg: null, official: true, user };
      }
      return { svg: avatarSvg(user.username, user.display_name), type: "image/svg+xml" };
    },
    deleteAccount(userId) {
      const user = getUser.get(userId);
      if (!user || user.is_system) throw Object.assign(new Error("That account cannot be deleted."), { status: 403 });
      const tombstone = `deleted_${userId.slice(0, 10)}`;
      const deleted = nowSec();
      deleteIdentities.run(userId);
      deleteSessions.run(userId);
      softDelete.run({ id: userId, username: tombstone, deleted_at: deleted });
      return {
        deleted: true,
        notice: "Your InstaOp profile is gone. Bitcoin transactions stay on the chain and cannot be deleted from here.",
      };
    },
    like(userId, postId) {
      const post = requirePost(postId);
      const added = like.run(userId, postId, nowSec());
      if (added.changes) notifyUser(post.author_id, userId, "like", postId, null);
      return counts(postId, userId);
    },
    unlike(userId, postId) {
      requirePost(postId);
      unlike.run(userId, postId);
      return counts(postId, userId);
    },
    save(userId, postId) {
      requirePost(postId);
      bookmark.run(userId, postId, nowSec());
      return counts(postId, userId);
    },
    unsave(userId, postId) {
      requirePost(postId);
      unbookmark.run(userId, postId);
      return counts(postId, userId);
    },
    comment(userId, postId, body, parentId = null) {
      const post = requirePost(postId);
      const text = String(body || "").trim().slice(0, 500);
      if (!text) throw Object.assign(new Error("Write a comment first."), { status: 400 });
      if (parentId) {
        const parent = getComment.get(parentId);
        if (!parent || parent.post_id !== postId) throw Object.assign(new Error("Reply target missing."), { status: 400 });
      }
      const id = newId();
      insertComment.run({ id, post_id: postId, user_id: userId, parent_id: parentId, body: text, created_at: nowSec() });
      notifyUser(post.author_id, userId, "comment", postId, id);
      for (const name of mentionUsernames(text)) {
        const mentioned = findByUsername(name);
        if (mentioned) notifyUser(mentioned.id, userId, "mention", postId, id);
      }
      return { comments: comments(postId), ...counts(postId, userId) };
    },
    deleteComment(userId, commentId) {
      const row = getComment.get(commentId);
      if (!row || row.deleted_at) throw Object.assign(new Error("Comment not found."), { status: 404 });
      if (row.user_id !== userId) throw Object.assign(new Error("You can only delete your own comments."), { status: 403 });
      hideComment.run(nowSec(), commentId);
      return { ok: true };
    },
    comments(postId) {
      return comments(postId);
    },
    counts(postId, viewerId) {
      return counts(postId, viewerId);
    },
    decorate(post, viewerId) {
      const social = getPost.get(post.id) || importPost(post);
      const author = social ? getUser.get(social.author_id) : official();
      const hidden = viewerId && blockedSet.all(viewerId).some((row) => row.blocked_id === author.id);
      if (hidden) return null;
      return {
        ...post,
        author: publicUser(author, viewerId),
        attribution: social?.attribution || IMPORT_ATTRIBUTION,
        source: social?.source || "opreturn_bot_import",
        ...counts(post.id, viewerId),
      };
    },
    homeIds(viewerId) {
      const bot = official();
      followOfficial(viewerId);
      const ids = new Set([bot.id]);
      if (viewerId) followingIds.all(viewerId).forEach((row) => ids.add(row.followee_id));
      return ids;
    },
    savedIds(userId) {
      return savedIds.all(userId).map((row) => row.post_id);
    },
    notifications(userId) {
      return {
        unread: unreadCount.get(userId).n,
        items: listNotes.all(userId).map((row) => ({
          id: row.id,
          kind: row.kind,
          postId: row.post_id,
          commentId: row.comment_id,
          createdAt: row.created_at,
          read: Boolean(row.read_at),
          actor: row.actor_username
            ? {
                username: row.actor_username,
                displayName: row.actor_display,
                avatarUrl: `/media/avatar/${encodeURIComponent(row.actor_username)}`,
              }
            : null,
        })),
      };
    },
    markNotificationsRead(userId) {
      markRead.run(nowSec(), userId);
      return this.notifications(userId);
    },
    report(userId, { postId, username, reason }) {
      const text = String(reason || "").trim().slice(0, 400);
      if (!text) throw Object.assign(new Error("Say why you are reporting this."), { status: 400 });
      const target = username ? findByUsername(username) : null;
      report.run(newId(), userId, postId || null, target?.id || null, text, nowSec());
      return { ok: true };
    },
    block(userId, username) {
      const target = findByUsername(username);
      if (!target || target.is_system || isOfficialUsername(target.username)) throw Object.assign(new Error("That account cannot be blocked."), { status: 400 });
      if (target.id === userId) throw Object.assign(new Error("You cannot block yourself."), { status: 400 });
      block.run(userId, target.id, nowSec());
      deleteFollow.run(userId, target.id);
      deleteFollow.run(target.id, userId);
      return { ok: true };
    },
    searchUsers(q) {
      const query = normalizeUsername(q);
      if (!query) return [];
      return listUsers.all()
        .filter((u) => u.username.includes(query) || u.display_name.toLowerCase().includes(query))
        .slice(0, 8)
        .map((u) => publicUser(u));
    },
  };

  function comments(postId) {
    return listComments.all(postId).map((row) => ({
      id: row.id,
      body: row.body,
      createdAt: row.created_at,
      parentId: row.parent_id,
      author: {
        username: row.username,
        displayName: row.deleted_at ? "Deleted account" : row.display_name,
        avatarUrl: `/media/avatar/${row.username}`,
      },
    }));
  }

  function counts(postId, viewerId) {
    return {
      likeCount: likeCount.get(postId).n,
      commentCount: commentCount.get(postId).n,
      liked: viewerId ? Boolean(liked.get(viewerId, postId)) : false,
      saved: viewerId ? Boolean(booked.get(viewerId, postId)) : false,
    };
  }
}

function extType(name) {
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

export { validUsername, RESERVED } from "./auth.mjs";
