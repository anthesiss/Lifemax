// ============================================================
// StatusMax.org — My Threads Page Controller
// ------------------------------------------------------------
// Shows every thread the logged-in user has started, newest
// first, across all forum categories. Gated behind login.
// ============================================================

import { AuthStore } from "./auth-firebase.js";
import { ThreadsStore } from "./threads-firebase.js";

const CATEGORY_LABELS = {
  bestofthebest: "Best of the Best",
  socialmaxing: "Socialmaxing",
  academicmaxing: "Academicmaxing",
  lifestylemaxing: "Lifestylemaxing",
  statusmax: "Status Max",
};

const listEl = document.getElementById("my-threads-list");

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

async function render() {
  const status = await AuthStore.getQueueStatus();

  if (!status.loggedIn) {
    listEl.innerHTML = `
      <div class="thread-row" style="grid-template-columns: 1fr; padding: 32px 20px; text-align:center;">
        <div>You need to be logged in to see your threads. <a href="#" data-auth-open="login">Log in</a> or <a href="#" data-auth-open="signup">register</a>.</div>
      </div>
    `;
    wireGateLinks();
    return;
  }

  const result = await ThreadsStore.getThreadsByAuthor(status.user.uid);

  if (!result.ok) {
    listEl.innerHTML = `<div class="thread-row" style="grid-template-columns: 1fr; padding: 24px 20px; text-align:center; color: var(--tag-serious-text);">${escapeHtml(result.error)}</div>`;
    return;
  }

  if (result.threads.length === 0) {
    listEl.innerHTML = `
      <div class="thread-row" style="grid-template-columns: 1fr; padding: 32px 20px; text-align:center; color: var(--text-faint);">
        You haven't started any threads yet.
      </div>
    `;
    return;
  }

  listEl.innerHTML = result.threads
    .map((t) => {
      const url = `thread.html?id=${encodeURIComponent(t.id)}&category=${encodeURIComponent(t.category)}`;
      const catLabel = CATEGORY_LABELS[t.category] || t.category;
      return `
      <div class="my-thread-row">
        <div>
          <a href="${url}" class="thread-title">${escapeHtml(t.title)}</a>
          <span class="thread-cat">${escapeHtml(catLabel)}</span>
        </div>
        <div class="thread-stat"><span class="num">${t.replyCount || 0}</span><span class="lbl">Replies</span></div>
        <div class="thread-stat"><span class="num">—</span><span class="lbl">Views</span></div>
        <div class="thread-when">${timeAgo(t.createdAtMs)}</div>
      </div>
    `;
    })
    .join("");
}

function wireGateLinks() {
  listEl.querySelectorAll("[data-auth-open]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const overlay = document.getElementById("auth-overlay");
      overlay.classList.add("open");
      const tab = el.dataset.authOpen;
      document.querySelectorAll(".auth-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
      document.getElementById("panel-login").classList.toggle("active", tab === "login");
      document.getElementById("panel-signup").classList.toggle("active", tab === "signup");
    });
  });
}

// Re-render after login/signup succeeds via the modal
document.getElementById("panel-login")?.addEventListener("submit", () => setTimeout(render, 300));
document.getElementById("panel-signup")?.addEventListener("submit", () => setTimeout(render, 300));

render();
