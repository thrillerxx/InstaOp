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
let lastTap = { id: "", at: 0 };
let toastTimer = null;

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

function toast(message) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 1800);
}
window.InstaOpToast = toast;

function timeLine(post) {
  const bits = [timeAgo(post.created_at)];
  if (post.txid) bits.push(`<a href="https://mempool.space/tx/${escapeHtml(post.txid)}" target="_blank" rel="noopener">View transaction</a>`);
  if (post.bytes) bits.push(`${post.bytes} bytes`);
  if (post.confirmed === true) bits.push("confirmed");
  if (post.confirmed === false) bits.push("in mempool");
  return bits.join(" · ");
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
  refreshOpenPost(post.id);
  if (fromLive && !existed && feedTab === "live" && !userPinned) {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function refreshOpenPost(id) {
  const pane = document.getElementById("post-view");
  if (!pane || pane.classList.contains("hidden")) return;
  const body = document.getElementById("post-body");
  if (body.querySelector(".post")?.dataset.id !== id) return;
  const current = posts.get(id);
  if (!current) return;
  body.innerHTML = card(current);
  wireCards(body);
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
        <button class="save${post.saved ? " saved" : ""} push" type="button" aria-label="Save"><svg viewBox="0 0 24 24"><path d="M6.2 4.4h11.6v15.2L12 16.2 6.2 19.6V4.4Z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button>
      </div>
      <p class="likes">${likes ? `${likes.toLocaleString()} like${likes === 1 ? "" : "s"}` : "Be the first to like this"}</p>
      <p class="caption"><b>${escapeHtml(author.username)}</b><span class="${long ? "clamp" : ""}">${linkify(post.message)} ${linkify(post.note || "")} <span class="tags">${tags}</span></span>${long ? ` <button class="more" type="button">more</button>` : ""}</p>
      <p class="source">${escapeHtml(post.attribution || "")}</p>
      <button class="comments open-comments" type="button">${comments ? `View ${comments} comment${comments === 1 ? "" : "s"}` : "Add a comment"}</button>
      <time class="time" data-ts="${post.created_at}">${timeLine(post)}</time>
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
    return `<div class="empty-box"><h3>Home is for people you follow</h3><p>Sign in to follow accounts. Live still shows every imported OP_RETURN.</p><button class="primary" data-auth type="button">Sign in</button></div>`;
  }
  if (feedTab === "home") {
    return `<div class="empty-box"><h3>Nothing new from people you follow</h3><p>@OP_RETURN_Bot stays on Home. Open Live for the full chain feed.</p></div>`;
  }
  return `<div class="empty-box"><h3>No posts here yet</h3><p>When a confirmed OP_RETURN lands, it shows up here.</p></div>`;
}

function skeletonFeed() {
  return `<article class="post skel-post" aria-hidden="true">
    <header class="post-head"><div class="skel skel-ava"></div><div class="skel skel-line w-120"></div></header>
    <div class="skel skel-media"></div>
    <div class="skel skel-line w-40"></div>
    <div class="skel skel-line w-80"></div>
  </article>
  <article class="post skel-post" aria-hidden="true">
    <header class="post-head"><div class="skel skel-ava"></div><div class="skel skel-line w-120"></div></header>
    <div class="skel skel-media"></div>
    <div class="skel skel-line w-40"></div>
  </article>`;
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
      <img src="${avatar(item.actor)}" alt="">
      <div><strong>${escapeHtml(item.actor?.username || "InstaOp")}</strong>
      <small>${escapeHtml(noteText(item))} · ${timeAgo(item.createdAt)}</small></div>
    </button>`).join("") || `<div class="empty-box"><h3>No notifications yet</h3><p>Likes, comments, follows, and mentions land here.</p></div>`;
}

function noteText(item) {
  if (item.kind === "like") return "liked your post";
  if (item.kind === "comment") return "commented";
  if (item.kind === "follow") return "started following you";
  if (item.kind === "mention") return "mentioned you";
  return item.kind;
}

function wireCards(root = feedEl) {
  root.querySelectorAll(".more").forEach((btn) => {
    btn.addEventListener("click", () => {
      const span = btn.parentElement.querySelector(".clamp");
      if (span) span.classList.remove("clamp");
      btn.remove();
    });
  });
  root.querySelectorAll(".like").forEach((btn) => {
    btn.addEventListener("click", () => toggleLike(btn.closest(".post").dataset.id));
  });
  root.querySelectorAll(".save").forEach((btn) => {
    btn.addEventListener("click", () => toggleSave(btn.closest(".post").dataset.id));
  });
  root.querySelectorAll(".open-comments").forEach((btn) => {
    btn.addEventListener("click", () => openComments(btn.closest(".post").dataset.id));
  });
  root.querySelectorAll(".share").forEach((btn) => {
    btn.addEventListener("click", () => sharePost(btn.closest(".post").dataset.id));
  });
  root.querySelectorAll("[data-tag]").forEach((btn) => {
    btn.addEventListener("click", () => openTag(btn.dataset.tag));
  });
  root.querySelectorAll(".mention").forEach((btn) => {
    btn.addEventListener("click", () => openProfile(btn.dataset.user));
  });
  root.querySelectorAll(".more-btn").forEach((btn) => {
    btn.addEventListener("click", () => moreMenu(btn.dataset.user, btn.closest(".post")?.dataset.id));
  });
  root.querySelectorAll(".media").forEach((el) => {
    el.addEventListener("click", (event) => {
      event.preventDefault();
      tapMedia(el.closest(".post").dataset.id, el);
    });
  });
  root.querySelectorAll("[data-user]").forEach((btn) => {
    if (btn.classList.contains("follow-user") || btn.classList.contains("more-btn") || btn.classList.contains("mention")) return;
    btn.addEventListener("click", () => openProfile(btn.dataset.user));
  });
  root.querySelectorAll("[data-auth]").forEach((btn) => {
    btn.addEventListener("click", () => openModal("auth-view"));
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
    toast("Link copied");
  } catch {
    window.prompt("Copy post link", url);
  }
}

function burstHeart(mediaEl) {
  const burst = document.createElement("div");
  burst.className = "burst";
  burst.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12.1 20.6S4.4 15.7 3.2 11.6C2.2 8.4 4 5.6 7.1 5.6c1.8 0 3.1 1.1 3.9 2.2.8-1.1 2.1-2.2 3.9-2.2 3.1 0 4.9 2.8 3.9 6-1.2 4.1-8.7 9-8.7 9Z" fill="#fff"/></svg>`;
  mediaEl.appendChild(burst);
  setTimeout(() => burst.remove(), 700);
}

function tapMedia(id, mediaEl) {
  const now = Date.now();
  if (lastTap.id === id && now - lastTap.at < 320) {
    lastTap = { id: "", at: 0 };
    burstHeart(mediaEl);
    const post = posts.get(id);
    if (!post?.liked) toggleLike(id);
    return;
  }
  lastTap = { id, at: now };
  setTimeout(() => {
    if (lastTap.id === id && Date.now() - lastTap.at >= 320) openPost(id);
  }, 320);
}

async function openPost(id) {
  let post = posts.get(id);
  if (!post) {
    try {
      const data = await api(`/api/posts/${encodeURIComponent(id)}`);
      post = data.post;
      posts.set(id, post);
    } catch {
      toast("Post not found");
      return;
    }
  }
  const pane = document.getElementById("post-view");
  document.getElementById("post-body").innerHTML = card(post);
  pane.classList.remove("hidden");
  history.replaceState(null, "", `#/p/${id}`);
  wireCards(document.getElementById("post-body"));
}

function closePost() {
  document.getElementById("post-view").classList.add("hidden");
}

function closeAction() {
  document.getElementById("action-view").classList.add("hidden");
}

function closePeople() {
  document.getElementById("people-view").classList.add("hidden");
}

function moreMenu(username, postId) {
  const sheet = document.getElementById("action-view");
  const list = document.getElementById("action-list");
  const post = postId ? posts.get(postId) : null;
  const canModerate = Boolean(me && username && username !== me.username && username !== "OP_RETURN_Bot");
  list.innerHTML = `
    <button type="button" data-act="copy">Copy link</button>
    ${post?.txid ? `<button type="button" data-act="tx">View transaction</button>` : ""}
    <button type="button" data-act="profile">View profile</button>
    ${canModerate ? `<button class="danger" type="button" data-act="report">Report</button><button class="danger" type="button" data-act="block">Block</button>` : ""}
    <button type="button" data-act="cancel">Cancel</button>
    <form id="report-form" class="hidden">
      <textarea id="report-reason" maxlength="400" placeholder="Why are you reporting this?"></textarea>
      <button class="primary" type="submit">Send report</button>
    </form>`;
  sheet.classList.remove("hidden");
  list.onclick = async (event) => {
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "cancel") return closeAction();
    if (act === "copy") {
      await sharePost(postId || "");
      return closeAction();
    }
    if (act === "tx" && post?.txid) {
      window.open(`https://mempool.space/tx/${post.txid}`, "_blank", "noopener");
      return;
    }
    if (act === "profile") {
      closeAction();
      return openProfile(username);
    }
    if (act === "report") {
      if (!needAuth("Sign in to report.")) return;
      document.getElementById("report-form").classList.remove("hidden");
      document.getElementById("report-reason").focus();
      return;
    }
    if (act === "block") {
      if (!needAuth("Sign in to block.")) return;
      if (!window.confirm(`Block @${username}? Their posts will disappear from your feeds.`)) return;
      try {
        await api(`/api/users/${encodeURIComponent(username)}/block`, { method: "POST", body: "{}" });
        closeAction();
        toast(`Blocked @${username}`);
        loadFeed();
      } catch (err) {
        toast(err.message);
      }
    }
  };
  document.getElementById("report-form").onsubmit = async (event) => {
    event.preventDefault();
    try {
      await api("/api/report", {
        method: "POST",
        body: JSON.stringify({ username, postId, reason: document.getElementById("report-reason").value }),
      });
      closeAction();
      toast("Report sent");
    } catch (err) {
      toast(err.message);
    }
  };
}

async function openPeople(kind) {
  const title = kind === "following" ? "Following" : "Followers";
  document.getElementById("people-title").textContent = title;
  const data = await api(`/api/users/${encodeURIComponent(profileUser)}/${kind}`);
  document.getElementById("people-list").innerHTML = (data.users || []).map((p) => `
    <button class="thread" data-user="${escapeHtml(p.username)}" type="button">
      <img src="${avatar(p)}" alt="">
      <div><strong>${escapeHtml(p.username)}</strong><small>${escapeHtml(p.displayName)}</small></div>
    </button>`).join("") || `<div class="empty-box"><h3>No one here yet</h3></div>`;
  document.getElementById("people-list").querySelectorAll("[data-user]").forEach((btn) => {
    btn.addEventListener("click", () => {
      closePeople();
      openProfile(btn.dataset.user);
    });
  });
  document.getElementById("people-view").classList.remove("hidden");
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
  closeAction();
  closePeople();
  if (view !== "create") closePost();
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
  closePost();
  closeAction();
  closePeople();
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
  const title = document.getElementById("profile-title");
  if (title) title.textContent = user.username;
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
  if (!posts.size) feedEl.innerHTML = skeletonFeed();
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
  if (route.startsWith("/p/")) openPost(route.slice(3));
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
  if (cell) openPost(cell.dataset.id);
});
profileGrid.addEventListener("click", (e) => {
  const cell = e.target.closest("[data-id]");
  if (cell) openPost(cell.dataset.id);
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

document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => go("home"));
});
document.getElementById("post-close").addEventListener("click", closePost);
document.getElementById("post-view").addEventListener("click", (event) => {
  if (event.target.id === "post-view") closePost();
});
document.getElementById("action-view").addEventListener("click", (event) => {
  if (event.target.id === "action-view") closeAction();
});
document.getElementById("people-close").addEventListener("click", closePeople);
document.getElementById("stat-followers-btn").addEventListener("click", () => openPeople("followers"));
document.getElementById("stat-following-btn").addEventListener("click", () => openPeople("following"));
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!document.getElementById("create-view").classList.contains("hidden")) {
    window.InstaOpComposer?.close();
    return;
  }
  if (!document.getElementById("action-view").classList.contains("hidden")) return closeAction();
  if (!document.getElementById("people-view").classList.contains("hidden")) return closePeople();
  if (!document.getElementById("comments-view").classList.contains("hidden")) {
    document.getElementById("comments-view").classList.add("hidden");
    return;
  }
  if (!document.getElementById("post-view").classList.contains("hidden")) return closePost();
  if (!document.getElementById("story-viewer").classList.contains("hidden")) return closeStory();
  if (!document.getElementById("auth-view").classList.contains("hidden")) return closeModal("auth-view");
  go("home");
});
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
  const who = event.target.closest("[data-user]:not(.follow-user)");
  if (who && !event.target.closest(".follow-user")) {
    openProfile(who.dataset.user);
    return;
  }
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
