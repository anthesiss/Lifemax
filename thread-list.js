// ============================================================
// StatusMax.org — Thread List Renderer
// ------------------------------------------------------------
// Renders a paginated list of real threads (from Firestore) into
// a forum page's .thread-list-block, matching the existing markup
// /CSS classes (thread-row, thread-tags, thread-title, etc.) so no
// visual changes are needed.
//
// Usage (on each forum page):
//   import { renderThreadList } from "./thread-list.js";
//   renderThreadList({
//     category: "bestofthebest",
//     listEl: document.getElementById("thread-list"),
//     paginationEl: document.getElementById("pagination"),
//   });
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

function threadAvatarHtml(pfpUrl) {
  if (pfpUrl) {
    return `<img class="thread-avatar" src="${pfpUrl.replace(/"/g, "&quot;")}" alt="" onerror="this.outerHTML='<div class=\\'thread-avatar\\'></div>';">`;
  }
  return `<div class="thread-avatar"></div>`;
}

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

async function threadRowHtml(thread, category) {
  const url = `thread.html?id=${encodeURIComponent(thread.id)}&category=${encodeURIComponent(category)}`;
  const lastActivityMs = thread.lastReplyAt || thread.createdAtMs;
  const lastAuthor = thread.lastReplyAuthor || thread.authorUsername;
  const lastAuthorUid = thread.lastReplyAuthorUid || thread.authorUid;
  const lastTitle = thread.lastReplyAt ? `Re: ${thread.title}` : thread.title;

  const [startedByHtml, lastByHtml, pfpUrl] = await Promise.all([
    usernameHtml(thread.authorUid, thread.authorUsername),
    usernameHtml(lastAuthorUid, lastAuthor),
    getCachedAuthorPfp(thread.authorUid),
  ]);

  return `
    <div class="thread-row">
      ${threadAvatarHtml(pfpUrl)}
      <div class="thread-main">
        <div class="thread-tags"><span class="tag tag-discussion">Discussion</span></div>
        <a href="${url}" class="thread-title">${escapeHtml(thread.title)}</a>
        <div class="thread-meta">Started by ${startedByHtml} · ${timeAgo(thread.createdAtMs)}</div>
      </div>
      <div class="thread-stat"><span class="num">${thread.replyCount || 0}</span><span class="lbl">Replies</span></div>
      <div class="thread-stat"><span class="num">—</span><span class="lbl">Views</span></div>
      <div class="thread-last">
        <span class="title">${escapeHtml(lastTitle)}</span>
        <span class="meta">${timeAgo(lastActivityMs)} · ${lastByHtml}</span>
      </div>
    </div>
  `;
}

function emptyStateHtml() {
  return `
    <div class="thread-row" style="grid-template-columns: 1fr;">
      <div class="thread-main" style="text-align:center; padding: 20px 0; color: var(--text-faint);">
        No threads here yet — be the first to post one.
      </div>
    </div>
  `;
}

function loadingStateHtml() {
  return `
    <div class="thread-row" style="grid-template-columns: 1fr;">
      <div class="thread-main" style="text-align:center; padding: 20px 0; color: var(--text-faint);">
        Loading threads…
      </div>
    </div>
  `;
}

/**
 * Renders a paginated, live-updating thread list into listEl,
 * with numbered page controls in paginationEl.
 */
export function renderThreadList({ category, listEl, paginationEl }) {
  // cursorChain[i] = the createdAtMs cursor needed to fetch page (i+2)
  const cursorChain = [];
  let currentPage = 1;
  let knownLastPage = null; // set once we discover hasMore === false

  async function loadPage(pageNumber) {
    listEl.innerHTML = loadingStateHtml();

    const result = await ThreadsStore.getThreadsPage(category, pageNumber, cursorChain);

    if (!result.ok) {
      listEl.innerHTML = `<div class="thread-row" style="grid-template-columns: 1fr;"><div class="thread-main" style="text-align:center; padding:20px 0; color:var(--tag-serious-text);">${escapeHtml(result.error || "Could not load threads.")}</div></div>`;
      return;
    }

    currentPage = pageNumber;

    // Record the cursor for the NEXT page if there is one
    if (result.hasMore && result.nextCursor !== null) {
      cursorChain[pageNumber - 1] = result.nextCursor;
    }
    if (!result.hasMore) {
      knownLastPage = pageNumber;
    }

    if (result.threads.length === 0) {
      listEl.innerHTML = pageNumber === 1 ? emptyStateHtml() : emptyStateHtml();
    } else {
      const rows = await Promise.all(result.threads.map((t) => threadRowHtml(t, category)));
      listEl.innerHTML = rows.join("");
    }

    renderPagination();
  }

  function renderPagination() {
    if (!paginationEl) return;

    // We only know pages we've actually visited / confirmed exist.
    // Show: Prev, current known pages, Next (if there's more).
    const maxKnownPage = knownLastPage !== null ? knownLastPage : Math.max(currentPage, cursorChain.length + 1);

    let html = "";
    html += `<span class="page-btn" data-page="prev" style="${currentPage <= 1 ? "opacity:0.4; pointer-events:none;" : ""}">‹ Prev</span>`;

    for (let p = 1; p <= maxKnownPage; p++) {
      html += `<span class="page-btn ${p === currentPage ? "active" : ""}" data-page="${p}">${p}</span>`;
    }

    const hasNext = knownLastPage === null || currentPage < knownLastPage;
    html += `<span class="page-btn" data-page="next" style="${!hasNext ? "opacity:0.4; pointer-events:none;" : ""}">Next ›</span>`;

    paginationEl.innerHTML = html;

    paginationEl.querySelectorAll("[data-page]").forEach((el) => {
      el.addEventListener("click", () => {
        const target = el.dataset.page;
        if (target === "prev") {
          if (currentPage > 1) loadPage(currentPage - 1);
        } else if (target === "next") {
          loadPage(currentPage + 1);
        } else {
          loadPage(parseInt(target, 10));
        }
      });
    });
  }

  loadPage(1);

  return { reload: () => loadPage(currentPage) };
}
