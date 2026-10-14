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
let storyItems = [];
let liveStories = [];
let feedCursor = null;
let feedDone = false;
let feedLoading = false;
let moreObs = null;
const feedScroll = { home: 0, live: 0 };
const seenStories = (() => {
  try { return new Set(JSON.parse(sessionStorage.getItem("instaop-seen-stories") || "[]")); } catch { return new Set(); }
})();
let replyTo = null;

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

function btcIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1.2 5.2h1.1V6h1.3v1.2h.7v1.3h-.7v1.3h.7v1.3h-.7V14h.7v1.3h-.7V17h-1.3v-1.7h-1.1V17H12v-1.7h-2.2l-.5-1.3h.6c.4 0 .6-.2.6-.6V8.6c0-.8.5-1.4 1.5-1.4h1.2V6h1.2v1.2Zm-1.1 4.7h1.1V8.6h-1.1v3.3Z"/></svg>`;
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
  const wide = post.artStyle === "mempool" ? " wide" : "";
  const alt = escapeHtml((post.message || "Onchain post").slice(0, 80));
  if (post.imageUrl) return `<div class="media${wide}"><div class="wait">Loading</div><img src="${post.imageUrl}" alt="${alt}" loading="lazy"></div>`;
  return `<div class="media${wide}"><div class="wait">Posting</div></div>`;
}

function card(post) {
  const author = post.author || { username: "OP_RETURN_Bot", displayName: "OP_RETURN Bo" };
  const long = (post.message || "").length > 120;
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
          <span class="sep">·</span>
          <time datetime="${post.created_at}">${timeAgo(post.created_at)}</time>
          ${post.txid ? `<button class="onchain-badge" data-chain="${post.id}" type="button" title="On Bitcoin" aria-label="On Bitcoin">${btcIcon()}</button>` : ""}
        </div>
        <button class="more-btn" data-user="${escapeHtml(author.username)}" type="button" aria-label="More">•••</button>
      </header>
      ${media(post)}
      <div class="actions">
        <button class="like${post.liked ? " liked" : ""}" type="button" aria-label="Like">${heart}</button>
        <button class="open-comments" type="button" aria-label="Comment"><svg viewBox="0 0 24 24"><path d="M4.4 5.2h15.2v10.4H8.2L4.4 19V5.2Z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button>
        <button class="share" type="button" aria-label="Share"><svg viewBox="0 0 24 24"><path d="m4 10.2 16-6.2-6.4 16.2-3.2-7.2L4 10.2Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>
        <button class="save${post.saved ? " saved" : ""} push" type="button" aria-label="Save"><svg viewBox="0 0 24 24"><path d="M6.2 4.4h11.6v15.2L12 16.2 6.2 19.6V4.4Z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button>
      </div>
      <p class="likes">${likes ? `${likes.toLocaleString()} like${likes === 1 ? "" : "s"}` : ""}</p>
      <p class="caption"><b>${escapeHtml(author.username)}</b><span class="${long ? "clamp" : ""}">${linkify(post.message)} <span class="tags">${tags}</span></span>${long ? ` <button class="more" type="button">more</button>` : ""}</p>
      ${post.note ? `<p class="caption-note">${linkify(post.note)}</p>` : ""}
      <button class="comments open-comments" type="button">${comments ? `View ${comments} comment${comments === 1 ? "" : "s"}` : "Add a comment"}</button>
    </article>`;
}

function renderAll() {
  feedEl.innerHTML = visible().map((post) => card(post)).join("") || emptyFeed();
  if (!feedDone && posts.size) {
    feedEl.insertAdjacentHTML("beforeend", `<div id="feed-more" class="feed-more">More posts</div>`);
  }
  renderStories();
  renderGrids();
  wireCards();
  watchMore();
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

function uniqueStories() {
  const items = [];
  const seen = new Set();
  for (const post of visible()) {
    const name = post.author?.username || "OP_RETURN_Bot";
    if (seen.has(name)) continue;
    seen.add(name);
    items.push(post);
  }
  return items;
}

function syncStoryArrows() {
  const row = storiesEl;
  const left = document.getElementById("story-left");
  const right = document.getElementById("story-right");
  if (!row || !left || !right) return;
  const overflow = row.scrollWidth > row.clientWidth + 8;
  left.classList.toggle("hidden", !overflow || row.scrollLeft < 8);
  right.classList.toggle("hidden", !overflow || row.scrollLeft + row.clientWidth >= row.scrollWidth - 8);
}

function storyGroups() {
  const groups = [];
  const seen = new Set();
  for (const story of liveStories) {
    const name = story.author?.username;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    groups.push({
      author: story.author,
      items: liveStories.filter((row) => row.author?.username === name),
    });
  }
  return groups;
}

function renderStories() {
  const groups = storyGroups();
  const add = me
    ? `<button class="story-chip add" data-add-story type="button" aria-label="Add a 24-hour story">
        <div class="story-ring add"><img src="${avatar(me)}" alt=""><i>+</i></div>
        <span>Your story</span>
      </button>`
    : "";
  const real = groups.map((group, index) => {
    const seen = seenStories.has(group.author.username) ? " seen" : "";
    return `
      <button class="story-chip${seen}" data-story-group="${index}" type="button">
        <div class="story-ring"><img src="${avatar(group.author)}" alt=""></div>
        <span>${escapeHtml(group.author.username)}</span>
      </button>`;
  }).join("");
  const fallback = groups.length ? "" : uniqueStories().map((post) => {
    const who = post.author || { username: "OP_RETURN_Bot" };
    return `
      <button class="story-chip activity" data-activity="${escapeHtml(post.id)}" type="button">
        <div class="story-ring muted"><img src="${avatar(who)}" alt=""></div>
        <span>${escapeHtml(who.username)}</span>
      </button>`;
  }).join("");
  storiesEl.innerHTML = add + real + fallback;
  requestAnimationFrame(syncStoryArrows);
}

function renderGrids() {
  searchGrid.innerHTML = visible().map((post) =>
    `<button type="button" data-id="${post.id}">${post.imageUrl ? `<img src="${post.imageUrl}" alt="">` : `<div class="ph"></div>`}</button>`
  ).join("");
}

function renderMe() {
  const ava = me ? avatar(me) : "/logo.png?v=icon5";
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
    </div>`).join("") || `<p class="hint">No suggestions yet.</p>`;
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
  if (item.kind === "comment_like") return "liked your comment";
  if (item.kind === "follow") return "started following you";
  if (item.kind === "mention") return "mentioned you";
  return item.kind;
}

function wireCards(root = feedEl) {
  root.querySelectorAll(".more").forEach((btn) => {
    btn.addEventListener("click", () => {
      const span = btn.parentElement.querySelector(".clamp, .opened");
      if (!span) return;
      if (span.classList.contains("clamp")) {
        span.classList.remove("clamp");
        span.classList.add("opened");
        btn.textContent = "less";
      } else {
        span.classList.add("clamp");
        span.classList.remove("opened");
        btn.textContent = "more";
      }
    });
  });
  root.querySelectorAll(".media img").forEach((img) => {
    const markReady = () => {
      img.classList.add("ready");
      const wait = img.previousElementSibling;
      if (wait?.classList.contains("wait")) wait.remove();
    };
    img.addEventListener("load", markReady);
    if (img.complete && img.naturalWidth) markReady();
    img.addEventListener("error", () => {
      const wait = document.createElement("div");
      wait.className = "wait";
      wait.textContent = "Image unavailable";
      img.replaceWith(wait);
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
  root.querySelectorAll("[data-chain]").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      openChain(btn.dataset.chain);
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
  if (!post) return;
  const liked = !post.liked;
  upsert({ ...post, liked, likeCount: Math.max(0, (post.likeCount || 0) + (liked ? 1 : -1)) }, false);
  try {
    const body = await api(`/api/posts/${encodeURIComponent(id)}/like`, { method: liked ? "POST" : "DELETE" });
    upsert({ ...posts.get(id), ...body }, false);
  } catch (err) {
    upsert(post, false);
    toast(err.message);
  }
}

async function toggleSave(id) {
  if (!needAuth("Sign in to save a post.")) return;
  const post = posts.get(id);
  if (!post) return;
  const saved = !post.saved;
  upsert({ ...post, saved }, false);
  try {
    const body = await api(`/api/posts/${encodeURIComponent(id)}/save`, { method: saved ? "POST" : "DELETE" });
    upsert({ ...posts.get(id), ...body }, false);
  } catch (err) {
    upsert(post, false);
    toast(err.message);
  }
}

async function sharePost(id) {
  const url = `${location.origin}${location.pathname}#/p/${id}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: "InstaOp", url });
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
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
    ${post?.txid ? `<button type="button" data-act="tx">On Bitcoin</button>` : ""}
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
    if (act === "tx" && postId) {
      closeAction();
      return openChain(postId);
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

function openMoreMenu() {
  const sheet = document.getElementById("action-view");
  const list = document.getElementById("action-list");
  list.innerHTML = `
    <button type="button" data-act="settings">Settings</button>
    <button type="button" data-act="install">Add to Home Screen</button>
    <button type="button" data-act="about">About InstaOp</button>
    <button type="button" data-act="cancel">Cancel</button>`;
  sheet.classList.remove("hidden");
  list.onclick = (event) => {
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (!act || act === "cancel") return closeAction();
    closeAction();
    if (act === "settings") return go("settings");
    if (act === "install") return promptInstall();
    if (act === "about") openAbout();
  };
}

async function openChain(id) {
  const post = posts.get(id);
  if (!post?.txid) return;
  const body = document.getElementById("chain-body");
  const status = post.confirmed === true ? "Confirmed" : post.confirmed === false ? "In mempool" : "Unknown";
  body.innerHTML = `
    <p class="btc">Bitcoin mainnet</p>
    <div><dt>Status</dt><dd>${escapeHtml(status)}</dd></div>
    <div><dt>Transaction</dt><dd>${escapeHtml(post.txid)}</dd></div>
    <div><dt>Onchain payload</dt><dd>${escapeHtml(post.message || "(binary or image bytes)")}${post.bytes ? ` · ${post.bytes} bytes` : ""}</dd></div>
    <div><dt>Rendered by InstaOp</dt><dd>${post.artStyle === "mempool" ? "Mempool.space transaction preview. Not the OP_RETURN bytes themselves." : "Generated artwork. The onchain payload is the text or image bytes above."}</dd></div>
    <p class="hint">A Bitcoin transaction does not identify who paid to publish this message.</p>
    <div class="row">
      <button class="ghost" type="button" id="copy-txid">Copy txid</button>
      <a class="primary" href="https://mempool.space/tx/${escapeHtml(post.txid)}" target="_blank" rel="noopener">Open in mempool.space</a>
    </div>`;
  document.getElementById("chain-view").classList.remove("hidden");
  document.getElementById("copy-txid").onclick = async () => {
    await navigator.clipboard.writeText(post.txid);
    toast("Transaction ID copied");
  };
  fetch(`https://mempool.space/api/tx/${post.txid}`).then((res) => res.ok ? res.json() : null).then((info) => {
    if (!info || document.getElementById("chain-view").classList.contains("hidden")) return;
    const bits = [];
    if (info.status?.block_height) bits.push(`<div><dt>Block</dt><dd>${info.status.block_height}</dd></div>`);
    if (info.status?.block_time) bits.push(`<div><dt>Block time</dt><dd>${new Date(info.status.block_time * 1000).toISOString()}</dd></div>`);
    if (typeof info.fee === "number") {
      const vbytes = info.weight ? info.weight / 4 : null;
      const rate = vbytes ? `${(info.fee / vbytes).toFixed(1)} sat/vB` : "";
      bits.push(`<div><dt>Fee</dt><dd>${info.fee} sats${rate ? ` · ${rate}` : ""}</dd></div>`);
    }
    if (!bits.length) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = bits.join("");
    body.insertBefore(wrap, body.querySelector(".hint"));
  }).catch(() => {});
}

function closeChain() {
  document.getElementById("chain-view").classList.add("hidden");
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
  const rows = data.comments || [];
  document.getElementById("comments-list").innerHTML = rows.map((row) => `
    <p class="comment${row.parentId ? " reply-row" : ""}"><b>${escapeHtml(row.author.username)}</b> ${linkify(row.body)}
    <small>${timeAgo(row.createdAt)}</small>
    ${me ? `<button class="reply" data-reply="${row.id}" data-name="${escapeHtml(row.author.username)}" type="button">Reply</button>` : ""}
    <button class="comment-like${row.liked ? " liked" : ""}" data-like-comment="${row.id}" type="button" aria-label="Like comment">♥ <em>${row.likeCount || ""}</em></button>
    ${me && row.author.username === me.username ? `<button data-del="${row.id}" type="button">delete</button>` : ""}</p>`).join("") || `<p class="empty">No comments yet. Comments stay offchain.</p>`;
  document.getElementById("comments-view").classList.remove("hidden");
  document.getElementById("comment-form").classList.toggle("hidden", !me);
  const input = document.getElementById("comment-input");
  if (me) input.focus();
  document.getElementById("comments-list").querySelectorAll(".mention").forEach((btn) => {
    btn.addEventListener("click", () => openProfile(btn.dataset.user));
  });
  document.getElementById("comments-list").querySelectorAll("[data-tag]").forEach((btn) => {
    btn.addEventListener("click", () => openTag(btn.dataset.tag));
  });
  document.getElementById("comments-list").querySelectorAll("[data-reply]").forEach((btn) => {
    btn.addEventListener("click", () => {
      replyTo = btn.dataset.reply;
      input.placeholder = `Reply to @${btn.dataset.name}`;
      input.focus();
    });
  });
  document.getElementById("comments-list").querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api(`/api/comments/${btn.dataset.del}`, { method: "DELETE" });
      openComments(id);
    });
  });
  document.getElementById("comments-list").querySelectorAll("[data-like-comment]").forEach((btn) => {
    btn.addEventListener("click", () => toggleCommentLike(btn.dataset.likeComment));
  });
}

async function toggleCommentLike(id) {
  if (!needAuth("Sign in to like a comment.")) return;
  const btn = document.querySelector(`[data-like-comment="${CSS.escape(id)}"]`);
  const liked = btn?.classList.contains("liked");
  if (btn) {
    btn.classList.toggle("liked", !liked);
    const next = Math.max(0, (Number(btn.querySelector("em")?.textContent || 0) || 0) + (liked ? -1 : 1));
    if (btn.querySelector("em")) btn.querySelector("em").textContent = next || "";
  }
  try {
    const body = await api(`/api/comments/${encodeURIComponent(id)}/like`, { method: liked ? "DELETE" : "POST" });
    if (btn) {
      btn.classList.toggle("liked", body.liked);
      if (btn.querySelector("em")) btn.querySelector("em").textContent = body.likeCount || "";
    }
  } catch (err) {
    if (btn) {
      btn.classList.toggle("liked", liked);
      const next = Math.max(0, (Number(btn.querySelector("em")?.textContent || 0) || 0) + (liked ? 1 : -1));
      if (btn.querySelector("em")) btn.querySelector("em").textContent = next || "";
    }
    toast(err.message);
  }
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
  const feed = await api("/api/feed?tab=live&limit=40");
  feed.posts.forEach((post) => posts.set(post.id, post));
  renderAll();
}

function go(view, extra) {
  closeAction();
  closePeople();
  if (view !== "create") closePost();
  if (view === "more") {
    openMoreMenu();
    return;
  }
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
    feedScroll[feedTab] = window.scrollY;
    feedTab = view;
    loadFeed().then(() => window.scrollTo(0, feedScroll[view] || 0));
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

function openAbout() {
  closeAction();
  openModal("about-view");
  history.replaceState(null, "", "#/about");
  document.getElementById("about-close")?.focus();
}

function closeAbout() {
  closeModal("about-view");
  if (location.hash === "#/about") history.replaceState(null, "", "#/");
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
  profileGrid.innerHTML = gridPosts.length
    ? gridPosts.map((post) =>
      `<button type="button" data-id="${post.id}">${post.imageUrl ? `<img src="${post.imageUrl}" alt="">` : `<div class="ph"></div>`}</button>`
    ).join("")
    : `<div class="empty-box"><h3>No posts yet</h3><p>Confirmed OP_RETURN posts show up here.</p></div>`;
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

function markStorySeen(username) {
  if (!username) return;
  seenStories.add(username);
  try { sessionStorage.setItem("instaop-seen-stories", JSON.stringify([...seenStories])); } catch { /* ignore */ }
}

function showStory() {
  const items = storyItems;
  if (!items.length) return;
  storyIndex = (storyIndex + items.length) % items.length;
  const post = items[storyIndex];
  const who = post.author || { username: "OP_RETURN_Bot" };
  markStorySeen(who.username);
  document.getElementById("story-image").src = post.imageUrl || avatar(who);
  document.getElementById("story-user").textContent = who.username;
  document.getElementById("story-caption").textContent = post.caption || post.message || (post.ephemeral ? "24-hour story · not on Bitcoin" : "");
  document.getElementById("story-progress").innerHTML = items.map((_, i) =>
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

async function loadFeed({ more = false } = {}) {
  if (feedLoading) return;
  if (more && (feedDone || !feedCursor)) return;
  feedLoading = true;
  if (!more) {
    feedCursor = null;
    feedDone = false;
    if (!posts.size) feedEl.innerHTML = skeletonFeed();
  }
  const tab = feedTab === "home" && me ? "home" : "live";
  const before = more && feedCursor ? `&before=${feedCursor}` : "";
  try {
    const data = await api(`/api/feed?tab=${tab}&limit=20${before}`);
    if (!more) posts.clear();
    (data.posts || []).forEach((post) => posts.set(post.id, post));
    feedCursor = data.nextBefore || null;
    feedDone = !data.nextBefore;
    renderAll();
  } finally {
    feedLoading = false;
  }
}

function watchMore() {
  const el = document.getElementById("feed-more");
  if (moreObs) moreObs.disconnect();
  if (!el) return;
  moreObs = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadFeed({ more: true });
  }, { rootMargin: "320px" });
  moreObs.observe(el);
}

async function loadStories() {
  try {
    const data = await api("/api/stories");
    liveStories = data.stories || [];
  } catch {
    liveStories = [];
  }
  renderStories();
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

function applyRoute() {
  const route = location.hash.slice(1);
  if (route.startsWith("/u/")) {
    openProfile(decodeURIComponent(route.slice(3)));
    return;
  }
  if (route.startsWith("/tag/")) {
    filterTag = decodeURIComponent(route.slice(5));
    searchInput.value = `#${filterTag}`;
    go("explore");
    return;
  }
  if (route === "/explore") return go("explore");
  if (route === "/notifications") return go("notifications");
  if (route === "/settings") return go("settings");
  if (route === "/live") return go("live");
  if (route.startsWith("/p/")) return openPost(route.slice(3));
  if (route === "/create") return go("create");
  if (route === "/about") return openAbout();
  if (!route || route === "/") {
    searchView.classList.add("hidden");
    profileView.classList.add("hidden");
    notesView.classList.add("hidden");
    settingsView.classList.add("hidden");
    document.getElementById("tab-home").classList.add("on");
    document.getElementById("tab-live").classList.remove("on");
  }
}

async function boot() {
  await loadMe();
  const route = location.hash.slice(1);
  if (route === "/live") feedTab = "live";
  await loadFeed();
  loadStories();
  api("/api/suggested").then((data) => renderSuggested(data.users)).catch(() => {});
  const status = await api("/api/status");
  liveBadge.classList.toggle("on", status.live);
  applyRoute();
  window.addEventListener("hashchange", applyRoute);
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
document.getElementById("story-left")?.addEventListener("click", () => {
  storiesEl.scrollBy({ left: -200, behavior: "smooth" });
});
document.getElementById("story-right")?.addEventListener("click", () => {
  storiesEl.scrollBy({ left: 200, behavior: "smooth" });
});
storiesEl.addEventListener("scroll", syncStoryArrows, { passive: true });
storiesEl.addEventListener("click", (event) => {
  if (event.target.closest("[data-add-story]")) {
    if (!needAuth("Sign in to publish a 24-hour story.")) return;
    document.getElementById("story-file")?.click();
    return;
  }
  const group = event.target.closest("[data-story-group]");
  if (group) {
    storyItems = storyGroups()[Number(group.dataset.storyGroup)]?.items || [];
    storyIndex = 0;
    showStory();
    return;
  }
  const activity = event.target.closest("[data-activity]");
  if (activity) openPost(activity.dataset.activity);
});
document.getElementById("story-file")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  const data = new FormData();
  data.append("photo", file);
  try {
    const res = await fetch("/api/stories", { method: "POST", body: data, credentials: "same-origin" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Could not publish story");
    toast("Story is up for 24 hours. It is not written to Bitcoin.");
    await loadStories();
  } catch (err) {
    toast(err.message);
  }
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
document.getElementById("chain-close").addEventListener("click", closeChain);
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
  if (!document.getElementById("chain-view").classList.contains("hidden")) return closeChain();
  if (!document.getElementById("comments-view").classList.contains("hidden")) {
    document.getElementById("comments-view").classList.add("hidden");
    return;
  }
  if (!document.getElementById("post-view").classList.contains("hidden")) return closePost();
  if (!document.getElementById("story-viewer").classList.contains("hidden")) return closeStory();
  if (!document.getElementById("about-view").classList.contains("hidden")) return closeAbout();
  if (!document.getElementById("auth-view").classList.contains("hidden")) return closeModal("auth-view");
  go("home");
});
document.getElementById("about-close").addEventListener("click", closeAbout);
document.getElementById("about-done").addEventListener("click", closeAbout);
document.getElementById("about-link")?.addEventListener("click", openAbout);
document.getElementById("about-view").addEventListener("click", (event) => {
  if (event.target.id === "about-view") closeAbout();
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
    loadStories();
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
    body: JSON.stringify({ body: input.value, parentId: replyTo }),
  });
  input.value = "";
  input.placeholder = "Add a comment…";
  replyTo = null;
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
