const posts = new Map();
let me = null;
let feedTab = "home";
let waiting = 0;
let storyIndex = 0;
let storyTimer = null;
let userPinned = false;
let filterTag = "";
let filterQuery = "";
let authMode = "register";
let profileUser = "OP_RETURN_Bot";
let profileMode = "posts";
let openCommentsId = "";
let notes = { unread: 0, items: [] };

const feedEl = document.getElementById("feed");
const storiesEl = document.getElementById("stories");
const liveBadge = document.getElementById("live-badge");
const newPill = document.getElementById("new-pill");
const searchView = document.getElementById("search-view");
const profileView = document.getElementById("profile-view");
const notesView = document.getElementById("notes-view");
const settingsView = document.getElementById("settings-view");
const searchInput = document.getElementById("search-input");
const searchGrid = document.getElementById("search-grid");
const profileGrid = document.getElementById("profile-grid");
const viewer = document.getElementById("story-viewer");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function api(path, options = {}) {
  return fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  }).then(async (res) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Request failed");
    return body;
  });
}

function sorted() {
  return [...posts.values()].sort((a, b) => b.created_at - a.created_at);
}

function visible() {
  return sorted().filter((post) => {
    if (filterTag && !(post.hashtags || []).some((tag) => tag.toLowerCase() === filterTag.toLowerCase())) return false;
    if (filterQuery && !`${post.message} ${post.note} ${post.author?.username || ""}`.toLowerCase().includes(filterQuery)) return false;
    return true;
  });
}

function timeAgo(ts) {
  const delta = Math.max(1, Math.floor(Date.now() / 1000) - ts);
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  if (delta < 604800) return `${Math.floor(delta / 86400)}d`;
  return `${Math.floor(delta / 604800)}w`;
}

function avatar(user) {
  return user?.avatarUrl || `/media/avatar/${encodeURIComponent(user?.username || "guest")}`;
}

function linkify(text) {
  return escapeHtml(String(text || ""))
    .replace(/(^|[^a-zA-Z0-9_])@([a-zA-Z0-9._]{3,24})\b/g, '$1<button type="button" class="mention" data-user="$2">@$2</button>')
    .replace(/(^|[^a-zA-Z0-9_])#([a-zA-Z0-9_]{2,32})\b/g, '$1<button type="button" class="hash" data-tag="$2">#$2</button>');
}

function siteLabel(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "") + (parsed.pathname === "/" ? "" : parsed.pathname);
  } catch {
    return url;
  }
}

function needAuth(action) {
  if (me) return true;
  openModal("auth-view");
  document.getElementById("auth-error").textContent = action || "Sign in to do that.";
  document.getElementById("auth-error").classList.remove("hidden");
  return false;
}

function upsert(post, fromLive) {
  if (!post || !post.id) return;
  const existed = posts.has(post.id);
  posts.set(post.id, { ...posts.get(post.id), ...post });
  if (!existed && fromLive && (userPinned || feedTab === "home")) {
    waiting += 1;
    newPill.textContent = `${waiting} new on Live`;
    newPill.classList.remove("hidden");
    renderChrome();
    return;
  }
  renderAll();
  if (fromLive && !existed && feedTab === "live" && !userPinned) {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function media(post) {
  if (post.imageUrl) return `<img src="${post.imageUrl}" alt="" class="ready">`;
  return `<div class="wait">Posting</div>`;
}

function card(post) {
  const author = post.author || { username: "OP_RETURN_Bot", displayName: "OP_RETURN Bo" };
  const long = (post.message || "").length > 140;
  const tags = (post.hashtags || []).map((tag) => `<button type="button" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</button>`).join(" ");
  const likes = post.likeCount || 0;
  const comments = post.commentCount || 0;
  const heart = `<svg viewBox="0 0 24 24"><path d="M12.1 20.6S4.4 15.7 3.2 11.6C2.2 8.4 4 5.6 7.1 5.6c1.8 0 3.1 1.1 3.9 2.2.8-1.1 2.1-2.2 3.9-2.2 3.1 0 4.9 2.8 3.9 6-1.2 4.1-8.7 9-8.7 9Z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;
  return `
    <article class="post" data-id="${post.id}">
      <header class="post-head">
        <button class="who-btn" data-user="${escapeHtml(author.username)}" type="button">
          <img class="ava" src="${avatar(author)}" alt="">
        </button>
        <div class="who">
          <button class="who-btn" data-user="${escapeHtml(author.username)}" type="button"><strong>${escapeHtml(author.username)}</strong></button>
          <small>${escapeHtml(author.city || "Bitcoin mainnet")}</small>
        </div>
        <button class="more-btn" data-user="${escapeHtml(author.username)}" type="button" aria-label="More">•••</button>
      </header>
      <div class="media">${media(post)}</div>
      <div class="actions">
        <button class="like${post.liked ? " liked" : ""}" type="button" aria-label="Like">${heart}</button>
        <button class="open-comments" type="button" aria-label="Comment"><svg viewBox="0 0 24 24"><path d="M4.4 5.2h15.2v10.4H8.2L4.4 19V5.2Z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button>
        <button class="share" type="button" aria-label="Share"><svg viewBox="0 0 24 24"><path d="m4 10.2 16-6.2-6.4 16.2-3.2-7.2L4 10.2Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>
        <button class="save${post.saved ? " liked" : ""} push" type="button" aria-label="Save"><svg viewBox="0 0 24 24"><path d="M6.2 4.4h11.6v15.2L12 16.2 6.2 19.6V4.4Z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button>
      </div>
      <p class="likes">${likes ? `${likes.toLocaleString()} like${likes === 1 ? "" : "s"}` : "Be the first to like this"}</p>
      <p class="caption"><b>${escapeHtml(author.username)}</b><span class="${long ? "clamp" : ""}">${linkify(post.message)} ${linkify(post.note || "")} <span class="tags">${tags}</span></span>${long ? ` <button class="more" type="button">more</button>` : ""}</p>
      <p class="source">${escapeHtml(post.attribution || "")}</p>
      <button class="comments open-comments" type="button">${comments ? `View ${comments} comment${comments === 1 ? "" : "s"}` : "Add a comment"}</button>
      <time class="time">${timeAgo(post.created_at)}${post.txid ? ` · <a href="https://mempool.space/tx/${post.txid}" target="_blank" rel="noopener">View transaction</a>` : ""}${post.bytes ? ` · ${post.bytes} bytes` : ""}${post.confirmed === true ? " · confirmed" : post.confirmed === false ? " · in mempool" : ""}</time>
    </article>`;
}

function renderAll() {
  feedEl.innerHTML = visible().map((post) => card(post)).join("") || emptyFeed();
  renderStories();
  renderGrids();
  wireCards();
}

function emptyFeed() {
  if (feedTab === "home" && !me) {
    return `<p class="empty">Sign in to follow people. Live still shows every imported OP_RETURN.</p>`;
  }
  return `<p class="empty">No posts here yet.</p>`;
}

function renderChrome() {
  renderStories();
  renderMe();
  renderNotesBadge();
}

function renderStories() {
  const chips = visible().slice(0, 12).map((post, index) => {
    const who = post.author || { username: "OP_RETURN_Bot" };
    return `
      <button class="story-chip" data-story="${index}" type="button">
        <div class="story-ring"><img src="${avatar(who)}" alt=""></div>
        <span>${escapeHtml(who.username)}</span>
      </button>`;
  }).join("");
  storiesEl.innerHTML = chips;
}

function renderGrids() {
  searchGrid.innerHTML = visible().map((post) =>
    `<button type="button" data-id="${post.id}">${post.imageUrl ? `<img src="${post.imageUrl}" alt="">` : `<div class="ph"></div>`}</button>`
  ).join("");
}

function renderMe() {
  const ava = me ? avatar(me) : "/logo.png";
  document.getElementById("me-ava").src = ava;
  document.getElementById("nav-ava").src = ava;
  document.getElementById("tab-ava").src = ava;
  document.getElementById("me-user").textContent = me ? me.username : "guest";
  document.getElementById("me-name").textContent = me ? me.displayName : "Browse the chain";
  document.getElementById("me-switch").textContent = me ? "Settings" : "Sign in";
}

function renderNotesBadge() {
  const badge = document.getElementById("note-badge");
  const n = notes.unread || 0;
  badge.textContent = String(n);
  badge.classList.toggle("hidden", n === 0);
}

function renderSuggested(users) {
  document.getElementById("suggested").innerHTML = (users || []).map((p) => `
    <div class="sug">
      <button class="who-btn" data-user="${escapeHtml(p.username)}" type="button"><img src="${avatar(p)}" alt=""></button>
      <div><strong>${escapeHtml(p.username)}</strong><small>${escapeHtml(p.displayName)}</small></div>
      <button class="follow follow-user" data-user="${escapeHtml(p.username)}" type="button">${p.viewerFollows ? "Following" : "Follow"}</button>
    </div>`).join("") || `<p class="hint">No other accounts yet. Invite someone to the private beta.</p>`;
}

function renderNotes() {
  document.getElementById("notes-list").innerHTML = (notes.items || []).map((item) => `
    <button class="thread" data-post="${item.postId || ""}" type="button">
      <div><strong>${escapeHtml(item.actor?.username || "InstaOp")}</strong>
      <small>${escapeHtml(noteText(item))} · ${timeAgo(item.createdAt)}</small></div>
    </button>`).join("") || `<p class="empty">No notifications yet.</p>`;
}

function noteText(item) {
  if (item.kind === "like") return "liked your post";
  if (item.kind === "comment") return "commented";
  if (item.kind === "follow") return "started following you";
  if (item.kind === "mention") return "mentioned you";
  return item.kind;
}

function wireCards() {
  feedEl.querySelectorAll(".more").forEach((btn) => {
    btn.addEventListener("click", () => {
      const span = btn.parentElement.querySelector(".clamp");
      if (span) span.classList.remove("clamp");
      btn.remove();
    });
  });
  feedEl.querySelectorAll(".like").forEach((btn) => {
    btn.addEventListener("click", () => toggleLike(btn.closest(".post").dataset.id));
  });
  feedEl.querySelectorAll(".save").forEach((btn) => {
    btn.addEventListener("click", () => toggleSave(btn.closest(".post").dataset.id));
  });
  feedEl.querySelectorAll(".open-comments").forEach((btn) => {
    btn.addEventListener("click", () => openComments(btn.closest(".post").dataset.id));
  });
  feedEl.querySelectorAll(".share").forEach((btn) => {
    btn.addEventListener("click", () => sharePost(btn.closest(".post").dataset.id));
  });
  feedEl.querySelectorAll("[data-tag]").forEach((btn) => {
    btn.addEventListener("click", () => openTag(btn.dataset.tag));
  });
  feedEl.querySelectorAll(".mention").forEach((btn) => {
    btn.addEventListener("click", () => openProfile(btn.dataset.user));
  });
  feedEl.querySelectorAll(".more-btn").forEach((btn) => {
    btn.addEventListener("click", () => moreMenu(btn.dataset.user));
  });
  document.querySelectorAll("[data-user]").forEach((btn) => {
    if (btn.classList.contains("follow-user") || btn.classList.contains("more-btn")) return;
    btn.addEventListener("click", () => openProfile(btn.dataset.user));
  });
}

async function toggleLike(id) {
  if (!needAuth("Sign in to like a post.")) return;
  const post = posts.get(id);
  const path = `/api/posts/${encodeURIComponent(id)}/like`;
  const body = await api(path, { method: post?.liked ? "DELETE" : "POST" });
  upsert({ ...post, ...body }, false);
}

async function toggleSave(id) {
  if (!needAuth("Sign in to save a post.")) return;
  const post = posts.get(id);
  const path = `/api/posts/${encodeURIComponent(id)}/save`;
  const body = await api(path, { method: post?.saved ? "DELETE" : "POST" });
  upsert({ ...post, ...body }, false);
}

async function sharePost(id) {
  const url = `${location.origin}${location.pathname}#/p/${id}`;
  try {
    await navigator.clipboard.writeText(url);
    newPill.textContent = "Link copied";
    newPill.classList.remove("hidden");
    setTimeout(() => { if (!waiting) newPill.classList.add("hidden"); }, 1600);
  } catch {
    window.prompt("Copy post link", url);
  }
}

function moreMenu(username) {
  if (!needAuth("Sign in to report or block.")) return;
  const reason = window.prompt(`Report @${username}? Describe the issue, or type BLOCK to block.`);
  if (!reason) return;
  if (reason.trim().toUpperCase() === "BLOCK") {
    api(`/api/users/${encodeURIComponent(username)}/block`, { method: "POST", body: "{}" }).then(loadFeed).catch(showError);
    return;
  }
  api("/api/report", { method: "POST", body: JSON.stringify({ username, reason }) }).catch(showError);
}

async function openComments(id) {
  openCommentsId = id;
  const data = await api(`/api/posts/${encodeURIComponent(id)}/comments`);
  document.getElementById("comments-list").innerHTML = data.comments.map((row) => `
    <p class="comment"><b>${escapeHtml(row.author.username)}</b> ${linkify(row.body)}
    ${me && row.author.username === me.username ? `<button data-del="${row.id}" type="button">delete</button>` : ""}</p>`).join("") || `<p class="empty">No comments yet.</p>`;
  document.getElementById("comments-view").classList.remove("hidden");
  document.getElementById("comment-form").classList.toggle("hidden", !me);
  document.getElementById("comments-list").querySelectorAll(".mention").forEach((btn) => {
    btn.addEventListener("click", () => openProfile(btn.dataset.user));
  });
  document.getElementById("comments-list").querySelectorAll("[data-tag]").forEach((btn) => {
    btn.addEventListener("click", () => openTag(btn.dataset.tag));
  });
  document.getElementById("comments-list").querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api(`/api/comments/${btn.dataset.del}`, { method: "DELETE" });
      openComments(id);
    });
  });
}

function openTag(tag) {
  filterTag = tag.replace(/^#/, "");
  filterQuery = "";
  searchInput.value = `#${filterTag}`;
  go("explore");
  history.replaceState(null, "", `#/tag/${encodeURIComponent(filterTag)}`);
  loadExplore();
}

async function loadExplore() {
  const data = await api("/api/tags");
  const rail = document.getElementById("tag-rail");
  const active = filterTag.toLowerCase();
  rail.innerHTML = (data.tags || []).map((row) =>
    `<button type="button" data-tag="${escapeHtml(row.tag)}" class="${row.tag.toLowerCase() === active ? "on" : ""}">#${escapeHtml(row.tag)} ${row.count}</button>`
  ).join("");
  rail.querySelectorAll("[data-tag]").forEach((btn) => {
    btn.addEventListener("click", () => openTag(btn.dataset.tag));
  });
  const feed = await api("/api/feed?tab=live");
  feed.posts.forEach((post) => posts.set(post.id, post));
  renderAll();
}

function go(view, extra) {
  searchView.classList.toggle("hidden", view !== "explore");
  profileView.classList.toggle("hidden", view !== "profile");
  notesView.classList.toggle("hidden", view !== "notifications");
  settingsView.classList.toggle("hidden", view !== "settings");
  document.querySelectorAll("[data-go]").forEach((el) => {
    el.classList.toggle("active", el.dataset.go === view || (view === "profile" && el.dataset.go === "profile"));
  });
  document.getElementById("tab-home").classList.toggle("on", view === "home");
  document.getElementById("tab-live").classList.toggle("on", view === "live");
  if (view === "home" || view === "live") {
    feedTab = view;
    loadFeed();
    history.replaceState(null, "", view === "live" ? "#/live" : "#/");
  }
  if (view === "explore") {
    if (!filterTag) history.replaceState(null, "", "#/explore");
    loadExplore();
  }
  if (view === "notifications") {
    loadNotes(true);
    history.replaceState(null, "", "#/notifications");
  }
  if (view === "create") {
    if (!needAuth("Sign in to publish to Bitcoin.")) return;
    window.InstaOpComposer?.open();
    history.replaceState(null, "", "#/create");
    return;
  }
  if (view === "profile") openProfile(extra || me?.username || "OP_RETURN_Bot");
  if (view === "settings") openSettings();
}

function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
}

function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

async function openProfile(username) {
  profileUser = username;
  profileView.classList.remove("hidden");
  searchView.classList.add("hidden");
  notesView.classList.add("hidden");
  settingsView.classList.add("hidden");
  history.replaceState(null, "", `#/u/${username}`);
  const data = await api(`/api/users/${encodeURIComponent(username)}`);
  const user = data.user;
  document.getElementById("profile-ava").src = avatar(user);
  document.getElementById("profile-user").textContent = user.username;
  document.getElementById("profile-name").textContent = user.displayName;
  document.getElementById("profile-city").textContent = user.city || "";
  document.getElementById("profile-bio").textContent = user.bio || "";
  const site = document.getElementById("profile-site");
  if (user.website) {
    site.href = user.website;
    site.textContent = siteLabel(user.website);
    site.classList.remove("hidden");
  } else {
    site.removeAttribute("href");
    site.textContent = "";
    site.classList.add("hidden");
  }
  document.getElementById("stat-posts").textContent = String(user.postCount || data.posts.length);
  document.getElementById("stat-followers").textContent = String(user.followerCount || 0);
  document.getElementById("stat-following").textContent = String(user.followingCount || 0);
  const followBtn = document.getElementById("profile-follow");
  const mine = me && me.username === user.username;
  const lockedFollow = user.isSystem || user.username === "OP_RETURN_Bot" || user.username === "opreturn";
  followBtn.classList.toggle("hidden", Boolean(mine));
  followBtn.disabled = lockedFollow;
  followBtn.textContent = lockedFollow || user.viewerFollows ? "Following" : "Follow";
  followBtn.dataset.user = user.username;
  document.getElementById("saved-tab").classList.toggle("hidden", !mine);
  document.getElementById("profile-actions").innerHTML = mine
    ? `<button class="ghost" data-go="settings" type="button">Edit profile</button>`
    : "";
  const gridPosts = profileMode === "saved" && mine ? (await api("/api/saved")).posts : data.posts;
  profileGrid.innerHTML = gridPosts.map((post) =>
    `<button type="button" data-id="${post.id}">${post.imageUrl ? `<img src="${post.imageUrl}" alt="">` : `<div class="ph"></div>`}</button>`
  ).join("");
  document.querySelector("#profile-actions [data-go]")?.addEventListener("click", () => go("settings"));
}

function openSettings() {
  if (!needAuth("Sign in to edit your profile.")) return;
  settingsView.classList.remove("hidden");
  document.getElementById("set-name").value = me.displayName || "";
  document.getElementById("set-bio").value = me.bio || "";
  document.getElementById("set-city").value = me.city || "";
  document.getElementById("set-site").value = me.website || "";
  history.replaceState(null, "", "#/settings");
}

function showStory() {
  const items = visible();
  if (!items.length) return;
  storyIndex = (storyIndex + items.length) % items.length;
  const post = items[storyIndex];
  const who = post.author || { username: "OP_RETURN_Bot" };
  document.getElementById("story-image").src = post.imageUrl || avatar(who);
  document.getElementById("story-user").textContent = who.username;
  document.getElementById("story-caption").textContent = post.message;
  document.getElementById("story-progress").innerHTML = items.slice(0, 12).map((_, i) =>
    `<i class="${i < storyIndex ? "done" : i === storyIndex ? "active" : ""}"><em></em></i>`
  ).join("");
  viewer.classList.remove("hidden");
  clearTimeout(storyTimer);
  storyTimer = setTimeout(() => {
    storyIndex += 1;
    if (storyIndex >= items.length) closeStory();
    else showStory();
  }, 4200);
}

function closeStory() {
  clearTimeout(storyTimer);
  viewer.classList.add("hidden");
}

async function loadMe() {
  const data = await api("/api/me");
  me = data.user;
  notes = data.notifications || { unread: 0, items: [] };
  renderMe();
  renderNotesBadge();
}

async function loadFeed() {
  const tab = feedTab === "home" && me ? "home" : "live";
  const data = await api(`/api/feed?tab=${tab}`);
  posts.clear();
  data.posts.forEach((post) => posts.set(post.id, post));
  renderAll();
}

async function loadNotes(mark) {
  if (!me) {
    notes = { unread: 0, items: [] };
    renderNotes();
    return;
  }
  notes = mark ? await api("/api/notifications/read", { method: "POST", body: "{}" }) : await api("/api/notifications");
  renderNotes();
  renderNotesBadge();
}

function showError(err) {
  const box = document.getElementById("auth-error");
  box.textContent = err.message || String(err);
  box.classList.remove("hidden");
}

async function boot() {
  await loadMe();
  const route = location.hash.slice(1);
  if (route.startsWith("/u/")) profileUser = route.slice(3);
  if (route === "/live") feedTab = "live";
  await loadFeed();
  api("/api/suggested").then((data) => renderSuggested(data.users)).catch(() => {});
  const status = await api("/api/status");
  liveBadge.classList.toggle("on", status.live);
  if (route.startsWith("/u/")) openProfile(profileUser);
  if (route.startsWith("/tag/")) {
    filterTag = decodeURIComponent(route.slice(5));
    searchInput.value = `#${filterTag}`;
    go("explore");
  }
  if (route === "/explore") go("explore");
  if (route === "/notifications") go("notifications");
  if (route === "/settings") go("settings");
  if (route.startsWith("/p/")) openComments(route.slice(3));
  const src = new EventSource("/api/stream");
  let opened = false;
  src.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.post) upsert(payload.post, true);
  };
  src.onerror = () => liveBadge.classList.remove("on");
  src.onopen = async () => {
    liveBadge.classList.add("on");
    if (opened) {
      const again = await api(`/api/feed?tab=live`);
      again.posts.forEach((post) => upsert(post, false));
    }
    opened = true;
  };
}

document.getElementById("tab-home").addEventListener("click", () => go("home"));
document.getElementById("tab-live").addEventListener("click", () => go("live"));
document.getElementById("new-pill").addEventListener("click", () => {
  waiting = 0;
  newPill.classList.add("hidden");
  userPinned = false;
  feedTab = "live";
  window.scrollTo({ top: 0, behavior: "smooth" });
  loadFeed();
});
document.getElementById("story-close").addEventListener("click", closeStory);
document.getElementById("story-prev").addEventListener("click", () => { storyIndex -= 1; showStory(); });
document.getElementById("story-next").addEventListener("click", () => { storyIndex += 1; showStory(); });
document.querySelectorAll("[data-go]").forEach((el) => {
  el.addEventListener("click", () => go(el.dataset.go));
});
storiesEl.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-story]");
  if (!chip) return;
  storyIndex = Number(chip.dataset.story);
  showStory();
});
searchGrid.addEventListener("click", (e) => {
  const cell = e.target.closest("[data-id]");
  if (cell) openComments(cell.dataset.id);
});
profileGrid.addEventListener("click", (e) => {
  const cell = e.target.closest("[data-id]");
  if (cell) openComments(cell.dataset.id);
});
searchInput.addEventListener("input", async () => {
  const value = searchInput.value.trim();
  filterTag = value.startsWith("#") ? value.slice(1) : "";
  filterQuery = filterTag || value.startsWith("@") ? "" : value.toLowerCase();
  if (value.startsWith("@") || (!value.startsWith("#") && value)) {
    const people = await api(`/api/users?q=${encodeURIComponent(value.replace(/^@/, ""))}`);
    document.getElementById("people-hits").innerHTML = people.users.map((p) =>
      `<button class="sug" data-user="${escapeHtml(p.username)}" type="button"><img src="${avatar(p)}" alt=""><div><strong>${escapeHtml(p.username)}</strong><small>${escapeHtml(p.displayName)}</small></div></button>`
    ).join("");
    document.getElementById("people-hits").querySelectorAll("[data-user]").forEach((btn) => {
      btn.addEventListener("click", () => openProfile(btn.dataset.user));
    });
  } else {
    document.getElementById("people-hits").innerHTML = "";
  }
  renderAll();
});
window.addEventListener("scroll", () => {
  userPinned = window.scrollY > 240;
}, { passive: true });

document.getElementById("me-switch").addEventListener("click", () => {
  if (me) go("settings");
  else openModal("auth-view");
});
document.getElementById("auth-close").addEventListener("click", () => closeModal("auth-view"));
document.getElementById("comments-close").addEventListener("click", () => {
  document.getElementById("comments-view").classList.add("hidden");
});
document.getElementById("auth-toggle").addEventListener("click", () => {
  authMode = authMode === "register" ? "login" : "register";
  document.getElementById("auth-submit").textContent = authMode === "register" ? "Create account" : "Sign in";
  document.getElementById("auth-toggle").textContent = authMode === "register" ? "I already have an account" : "Create an account";
  document.getElementById("auth-username").parentElement.classList.toggle("hidden", authMode === "login");
});
document.getElementById("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const body = {
      username: document.getElementById("auth-username").value,
      email: document.getElementById("auth-email").value,
      password: document.getElementById("auth-password").value,
      displayName: document.getElementById("auth-username").value,
      identifier: document.getElementById("auth-email").value || document.getElementById("auth-username").value,
    };
    const path = authMode === "register" ? "/api/auth/register" : "/api/auth/login";
    const data = await api(path, { method: "POST", body: JSON.stringify(body) });
    me = data.user;
    closeModal("auth-view");
    renderMe();
    loadFeed();
    api("/api/suggested").then((row) => renderSuggested(row.users));
  } catch (err) {
    showError(err);
  }
});
document.getElementById("nostr-btn").addEventListener("click", async () => {
  try {
    if (!window.nostr?.signEvent) throw new Error("Install a Nostr signer such as Alby or nos2x. InstaOp never asks for your private key.");
    const { challenge } = await api("/api/auth/nostr/challenge");
    const event = await window.nostr.signEvent({
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["challenge", challenge], ["u", location.origin]],
      content: "InstaOp login",
    });
    const data = await api("/api/auth/nostr", { method: "POST", body: JSON.stringify({ event, challenge }) });
    me = data.user;
    closeModal("auth-view");
    renderMe();
    loadFeed();
  } catch (err) {
    showError(err);
  }
});
document.getElementById("comment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!needAuth("Sign in to comment.")) return;
  const input = document.getElementById("comment-input");
  const data = await api(`/api/posts/${encodeURIComponent(openCommentsId)}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: input.value }),
  });
  input.value = "";
  const post = posts.get(openCommentsId);
  if (post) upsert({ ...post, ...data }, false);
  openComments(openCommentsId);
});
document.getElementById("profile-follow").addEventListener("click", async () => {
  if (document.getElementById("profile-follow").disabled) return;
  if (!needAuth("Sign in to follow people.")) return;
  const username = document.getElementById("profile-follow").dataset.user;
  const following = document.getElementById("profile-follow").textContent === "Following";
  await api(`/api/users/${encodeURIComponent(username)}/follow`, { method: following ? "DELETE" : "POST" });
  openProfile(username);
});
document.getElementById("suggested").addEventListener("click", async (event) => {
  const btn = event.target.closest(".follow-user");
  if (!btn) return;
  if (!needAuth("Sign in to follow people.")) return;
  const following = btn.textContent === "Following";
  const data = await api(`/api/users/${encodeURIComponent(btn.dataset.user)}/follow`, { method: following ? "DELETE" : "POST" });
  btn.textContent = data.user.viewerFollows ? "Following" : "Follow";
});
document.getElementById("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = await api("/api/me", {
    method: "PATCH",
    body: JSON.stringify({
      displayName: document.getElementById("set-name").value,
      bio: document.getElementById("set-bio").value,
      city: document.getElementById("set-city").value,
      website: document.getElementById("set-site").value,
    }),
  });
  me = user.user;
  const file = document.getElementById("set-photo").files[0];
  if (file) {
    const body = new FormData();
    body.append("avatar", file, file.name);
    const updated = await fetch("/api/me/avatar", { method: "POST", body, credentials: "same-origin" }).then((r) => r.json());
    if (updated.user) me = updated.user;
  }
  renderMe();
  openProfile(me.username);
});
document.getElementById("logout-btn").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST", body: "{}" });
  me = null;
  renderMe();
  go("live");
});
document.getElementById("delete-btn").addEventListener("click", async () => {
  if (!window.confirm("Delete your InstaOp account? Bitcoin transactions stay on the chain.")) return;
  await api("/api/me", { method: "DELETE" });
  me = null;
  renderMe();
  go("live");
});
document.getElementById("saved-tab").addEventListener("click", () => {
  profileMode = "saved";
  document.getElementById("saved-tab").classList.add("on");
  document.getElementById("posts-tab").classList.remove("on");
  openProfile(me.username);
});
document.getElementById("posts-tab").addEventListener("click", () => {
  profileMode = "posts";
  document.getElementById("posts-tab").classList.add("on");
  document.getElementById("saved-tab").classList.remove("on");
  openProfile(profileUser);
});
document.getElementById("notes-list").addEventListener("click", (event) => {
  const btn = event.target.closest("[data-post]");
  if (btn?.dataset.post) openComments(btn.dataset.post);
});

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

let deferredInstall = null;

function syncInstallUi() {
  const standalone = isStandalone();
  document.documentElement.classList.toggle("standalone", standalone);
  const pill = document.getElementById("install-pill");
  const btn = document.getElementById("install-btn");
  const copy = document.getElementById("install-copy");
  if (standalone) {
    pill?.classList.add("hidden");
    btn?.classList.add("hidden");
    if (copy) copy.textContent = "InstaOp is installed on this device.";
    return;
  }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (deferredInstall) {
    pill?.classList.remove("hidden");
    btn?.classList.remove("hidden");
    if (copy) copy.textContent = "Install InstaOp as an app on this phone.";
    return;
  }
  pill?.classList.toggle("hidden", !ios);
  btn?.classList.add("hidden");
  if (copy) {
    copy.textContent = ios
      ? "On iPhone: tap Share, then Add to Home Screen."
      : "Use your browser menu to install InstaOp or Add to Home Screen.";
  }
}

function promptInstall() {
  if (deferredInstall) {
    const pending = deferredInstall;
    pending.prompt();
    pending.userChoice.finally(() => {
      deferredInstall = null;
      syncInstallUi();
    });
    return;
  }
  window.alert("On iPhone: tap Share, then Add to Home Screen.\nOn Android: open the browser menu and tap Install app.");
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstall = event;
  syncInstallUi();
});
window.addEventListener("appinstalled", () => {
  deferredInstall = null;
  syncInstallUi();
});
document.getElementById("install-pill")?.addEventListener("click", promptInstall);
document.getElementById("install-btn")?.addEventListener("click", promptInstall);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
}
syncInstallUi();

boot().catch(console.error);
