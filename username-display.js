// ============================================================
// LifeMax.in — Username Display Helper
// ------------------------------------------------------------
// Thread/reply documents only store a denormalized authorUsername
// string (set once, at post time) — they don't know if that author
// has since deactivated their account. This helper checks live
// deactivation status (with an in-memory cache so repeated lookups
// for the same author across a list are nearly free) and renders
// either a normal profile link or a struck-through, non-clickable
// name, matching the same treatment already used in thread-page.js's
// comment sidebars.
// ============================================================

import { AuthStore } from "./auth-firebase.js";

const deactivatedCache = new Map();

async function isDeactivated(uid) {
  if (!uid) return false;
  if (deactivatedCache.has(uid)) return deactivatedCache.get(uid);
  const user = await AuthStore.getUserByUid(uid);
  const result = !!(user && user.deactivated);
  deactivatedCache.set(uid, result);
  return result;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

/**
 * Returns an HTML string for a username: a normal profile link
 * normally, or a struck-through plain span if that author has
 * deactivated their account.
 */
export async function usernameHtml(uid, username) {
  const deactivated = await isDeactivated(uid);
  if (deactivated) {
    return `<span style="text-decoration: line-through; color: var(--text-faint);">${escapeHtml(username)}</span>`;
  }
  return `<a href="profile.html?user=${encodeURIComponent(username)}">${escapeHtml(username)}</a>`;
}
