// ============================================================
// StatusMax.org — Homepage Controller
// ------------------------------------------------------------
// Populates the dynamic parts of index.html with real Firestore
// data: the "New Threads" sidebar, the site-wide stats box, and
// each category row's thread/post counts + latest-thread preview.
// ============================================================

import { ThreadsStore } from "./threads-firebase.js";
import { AuthStore } from "./auth-firebase.js";
import { usernameHtml } from "./username-display.js";

const pfpCache = new Map();
async function getCachedAuthorPfp(uid) {
  if (!uid) return "";
  if (pfpCache.has(uid)) return pfpCache.get(uid);
  const user = await AuthStore.getUserByUid(uid);
  const pfpUrl = user?.pfpUrl || "";
  pfpCache.set(uid, pfpUrl);
  return pfpUrl;
}

function escapeHtmlAttr(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function avatarHtml(pfpUrl, username) {
  if (pfpUrl) {
    return `<img class="avatar" src="${escapeHtmlAttr(pfpUrl)}" alt="" onerror="this.outerHTML='<div class=\\'avatar\\'></div>';">`;
  }
  return `<div class="avatar"></div>`;
}

const CATEGORIES = ["bestofthebest", "socialmaxing", "academicmaxing", "lifestylemaxing", "statusmax"];
const CATEGORY_LABELS = {
  bestofthebest: "Best of the Best",
  socialmaxing: "Social Maxing",
  academicmaxing: "Academic Maxing",
  lifestylemaxing: "Lifestylemaxing",
  statusmax: "Status Max",
};

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function timeAgo(ms) {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "a moment ago";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const month = Math.floor(day / 30);
  return `${month} month${month === 1 ? "" : "s"} ago`;
}

function formatCount(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

// ---------- New Threads sidebar ----------
async function renderNewThreadsSidebar() {
  const listEl = document.getElementById("new-threads-list");
  if (!listEl) return;

  const result = await ThreadsStore.getLatestThreadsAcrossAllCategories(4);

  if (!result.ok || result.threads.length === 0) {
    listEl.innerHTML = `<div class="thread-item"><div class="thread-body" style="color: var(--text-faint);">No threads yet — be the first to post one.</div></div>`;
    return;
  }

  const rows = await Promise.all(
    result.threads.map(async (t) => {
      const url = `thread.html?id=${encodeURIComponent(t.id)}&category=${encodeURIComponent(t.category)}`;
      const catLabel = CATEGORY_LABELS[t.category] || t.category;
      const [startedByHtml, pfpUrl] = await Promise.all([
        usernameHtml(t.authorUid, t.authorUsername),
        getCachedAuthorPfp(t.authorUid),
      ]);
      return `
      <div class="thread-item">
        ${avatarHtml(pfpUrl, t.authorUsername)}
        <div class="thread-body">
          <span class="title"><a href="${url}" style="color:inherit;">${escapeHtml(t.title)}</a></span>
          <span class="meta">Started by ${startedByHtml} · ${timeAgo(t.createdAtMs)}</span>
          <span class="forum-name">${escapeHtml(catLabel)}</span>
        </div>
      </div>
    `;
    })
  );
  listEl.innerHTML = rows.join("");
}

// ---------- Site-wide stats ----------
async function renderSiteStats() {
  const gridEl = document.getElementById("site-stats-grid");
  if (!gridEl) return;

  const [statsResult, userCountResult] = await Promise.all([
    ThreadsStore.getSiteStats(),
    AuthStore.getUserCount(),
  ]);

  gridEl.innerHTML = `
    <div><span class="stat-num">${formatCount(statsResult.threadCount)}</span><span class="stat-lbl">Threads</span></div>
    <div><span class="stat-num">${formatCount(statsResult.postCount)}</span><span class="stat-lbl">Posts</span></div>
    <div><span class="stat-num">${formatCount(userCountResult.count)}</span><span class="stat-lbl">Members</span></div>
  `;
}

// ---------- Per-category stats + latest thread preview ----------
async function renderCategoryPreview(category) {
  const threadsStatEl = document.getElementById(`stat-threads-${category}`);
  const postsStatEl = document.getElementById(`stat-posts-${category}`);
  const latestEl = document.getElementById(`latest-${category}`);
  if (!threadsStatEl || !postsStatEl || !latestEl) return;

  const result = await ThreadsStore.getThreadsByCategory(category, null);

  if (!result.ok) return;

  // We only fetched one page (up to 20), so for an exact thread count on
  // busy forums you'd want a maintained counter — this is good enough
  // for "how active does this forum look" at a glance.
  const threads = result.threads;
  let totalReplies = 0;
  threads.forEach((t) => (totalReplies += t.replyCount || 0));
  const totalPosts = threads.length + totalReplies;

  threadsStatEl.textContent = result.hasMore ? `${formatCount(threads.length)}+` : formatCount(threads.length);
  postsStatEl.textContent = result.hasMore ? `${formatCount(totalPosts)}+` : formatCount(totalPosts);

  if (threads.length === 0) {
    latestEl.innerHTML = `
      <div class="cat-latest-text">
        <span class="title">No threads yet</span>
        <span class="meta">Be the first to post</span>
      </div>
    `;
    return;
  }

  const newest = threads[0]; // already sorted newest-first
  const url = `thread.html?id=${encodeURIComponent(newest.id)}&category=${encodeURIComponent(category)}`;
  const [authorHtml, pfpUrl] = await Promise.all([
    usernameHtml(newest.authorUid, newest.authorUsername),
    getCachedAuthorPfp(newest.authorUid),
  ]);
  latestEl.innerHTML = `
    ${avatarHtml(pfpUrl, newest.authorUsername)}
    <div class="cat-latest-text">
      <span class="title"><a href="${url}" style="color:inherit;">${escapeHtml(newest.title)}</a></span>
      <span class="meta">${timeAgo(newest.createdAtMs)} · ${authorHtml}</span>
    </div>
  `;
}

// ---------- Featured (VIP threads) ----------
async function renderFeaturedVip() {
  const blockEl = document.getElementById("featured-vip-block");
  const listEl = document.getElementById("featured-vip-list");
  if (!blockEl || !listEl) return;

  const result = await ThreadsStore.getFeaturedVipThreads(AuthStore.getUserByUid, 4);
  const threads = result.ok ? result.threads : [];

  if (threads.length === 0) {
    blockEl.style.display = "none";
    return;
  }

  blockEl.style.display = "";

  const rows = await Promise.all(
    threads.map(async (t) => {
      const url = `thread.html?id=${encodeURIComponent(t.id)}&category=${encodeURIComponent(t.category)}`;
      const catLabel = CATEGORY_LABELS[t.category] || t.category;
      const [startedByHtml, pfpUrl] = await Promise.all([
        usernameHtml(t.authorUid, t.authorUsername),
        getCachedAuthorPfp(t.authorUid),
      ]);
      return `
      <div class="thread-item">
        ${avatarHtml(pfpUrl, t.authorUsername)}
        <div class="thread-body">
          <span class="title"><a href="${url}" style="color:inherit;">${escapeHtml(t.title)}</a> <span class="vip-badge" title="VIP" style="vertical-align:middle;">VIP</span></span>
          <span class="meta">Started by ${startedByHtml} · ${timeAgo(t.createdAtMs)}</span>
          <span class="forum-name">${escapeHtml(catLabel)}</span>
        </div>
      </div>
    `;
    })
  );
  listEl.innerHTML = rows.join("");
}

async function init() {
  renderNewThreadsSidebar();
  renderSiteStats();
  renderFeaturedVip();
  CATEGORIES.forEach((cat) => renderCategoryPreview(cat));
}

init();
