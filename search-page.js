// ============================================================
// LifeMax.in — Search Page Controller
// ------------------------------------------------------------
// Lets the person pick "Threads" or "Users" via a toggle, then
// searches the corresponding collection as they type (debounced).
// ============================================================

import { AuthStore } from "./auth-firebase.js";
import { ThreadsStore } from "./threads-firebase.js";
import { usernameHtml } from "./username-display.js";

const CATEGORY_LABELS = {
  bestofthebest: "Best of the Best",
  socialmaxing: "Socialmaxing",
  academicmaxing: "Academicmaxing",
  lifestylemaxing: "Lifestylemaxing",
  statusmax: "Status Max",
};

const toggleThreadsBtn = document.getElementById("toggle-threads");
const toggleUsersBtn = document.getElementById("toggle-users");
const input = document.getElementById("search-input");
const resultsEl = document.getElementById("search-results");

let searchType = "threads";
let debounceTimer = null;

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function setType(type) {
  searchType = type;
  toggleThreadsBtn.classList.toggle("active", type === "threads");
  toggleUsersBtn.classList.toggle("active", type === "users");
  input.placeholder = type === "threads" ? "Search threads by title..." : "Search by username...";
  input.value = "";
  resultsEl.innerHTML = `<div class="search-empty-state">Start typing to search.</div>`;
}

toggleThreadsBtn.addEventListener("click", () => setType("threads"));
toggleUsersBtn.addEventListener("click", () => setType("users"));

input.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  const text = input.value.trim();
  if (!text) {
    resultsEl.innerHTML = `<div class="search-empty-state">Start typing to search.</div>`;
    return;
  }
  resultsEl.innerHTML = `<div class="search-empty-state">Searching…</div>`;
  debounceTimer = setTimeout(() => runSearch(text), 350);
});

async function runSearch(text) {
  if (searchType === "threads") {
    const result = await ThreadsStore.searchThreads(text);
    await renderThreadResults(result.ok ? result.threads : []);
  } else {
    const result = await AuthStore.searchUsers(text);
    renderUserResults(result.ok ? result.users : []);
  }
}

async function renderThreadResults(threads) {
  if (threads.length === 0) {
    resultsEl.innerHTML = `<div class="search-empty-state">No threads found.</div>`;
    return;
  }
  const rows = await Promise.all(
    threads.map(async (t) => {
      const url = `thread.html?id=${encodeURIComponent(t.id)}&category=${encodeURIComponent(t.category)}`;
      const catLabel = CATEGORY_LABELS[t.category] || t.category;
      const authorHtml = await usernameHtml(t.authorUid, t.authorUsername);
      return `
      <div class="search-result-row">
        <div class="result-info">
          <a href="${url}" class="result-title">${escapeHtml(t.title)}</a>
          <span class="result-meta">${escapeHtml(catLabel)} · started by ${authorHtml}</span>
        </div>
      </div>
    `;
    })
  );
  resultsEl.innerHTML = rows.join("");
}

function renderUserResults(users) {
  if (users.length === 0) {
    resultsEl.innerHTML = `<div class="search-empty-state">No users found.</div>`;
    return;
  }
  resultsEl.innerHTML = users
    .map((u) => {
      const url = `profile.html?user=${encodeURIComponent(u.username)}`;
      const pfp = u.pfpUrl
        ? `<img class="result-pfp" src="${escapeHtml(u.pfpUrl)}" alt="">`
        : `<div class="result-pfp pfp-initial" style="display:flex; align-items:center; justify-content:center; font-size:16px;">${escapeHtml((u.username || "?").charAt(0).toUpperCase())}</div>`;
      return `
      <div class="search-result-row">
        ${pfp}
        <div class="result-info">
          <a href="${url}" class="result-title">${escapeHtml(u.username)}</a>
          <span class="result-meta">${u.reputation || 0} reputation</span>
        </div>
      </div>
    `;
    })
    .join("");
}
