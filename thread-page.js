// ============================================================
// LifeMax.in — Thread Page Controller
// ------------------------------------------------------------
// Reads ?id= and &category= from the URL, loads the thread and
// its replies from Firestore, renders them in the sidebar-card
// layout (avatar, username, bio, Joined/Reputation on the left;
// content + like button on the right), and wires up:
//   - the reply box (gated behind login + the 1-minute queue)
//   - unlimited-click like buttons
//   - rank glow/particles/badges next to each username
//   - delete (with a 24h undo window) for your own thread/replies
//   - optional image attached to the original post / each reply
//   - deactivated-author handling (struck-through username)
//   - deleted-content placeholders
// ============================================================

import { ThreadsStore } from "./threads-firebase.js";
import { AuthStore } from "./auth-firebase.js";
import { requirePostingAccess } from "./auth-ui.js";
import { getRankInfo, glowStyle, badgesHtml, particlesHtml } from "./rank-system.js";

const CATEGORY_LABELS = {
  bestofthebest: "Best of the Best",
  socialmaxing: "Socialmaxing",
  academicmaxing: "Academicmaxing",
  lifestylemaxing: "Lifestylemaxing",
  statusmax: "Status Max",
};

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function formatDate(ms) {
  if (!ms) return "Unknown";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
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

function hoursLeft(ms) {
  return Math.max(0, Math.ceil((ms - Date.now()) / (60 * 60 * 1000)));
}

function initialPfpHtml(username, cls) {
  const initial = (username || "?").trim().charAt(0).toUpperCase() || "?";
  return `<div class="${cls} pfp-initial">${escapeHtml(initial)}</div>`;
}

function pfpHtml(pfpUrl, username, cls) {
  if (pfpUrl) {
    return `<img class="${cls}" src="${escapeHtml(pfpUrl)}" alt="" onerror='this.outerHTML=${JSON.stringify(initialPfpHtml(username, cls))}'>`;
  }
  return initialPfpHtml(username, cls);
}

const likeIconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3zM7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3"/></svg>`;

const params = new URLSearchParams(window.location.search);
const threadId = params.get("id");
const category = params.get("category") || "";
const container = document.getElementById("thread-container");

// Simple in-memory cache so we don't re-fetch the same user doc
// repeatedly when they've posted multiple replies in this thread.
const userCache = new Map();
async function getCachedUser(uid) {
  if (!uid) return null;
  if (userCache.has(uid)) return userCache.get(uid);
  const user = await AuthStore.getUserByUid(uid);
  userCache.set(uid, user);
  return user;
}

async function init() {
  if (!threadId) {
    container.innerHTML = `<div class="thread-error">No thread specified.</div>`;
    return;
  }

  const result = await ThreadsStore.getThread(threadId);
  if (!result.ok) {
    container.innerHTML = `<div class="thread-error">${escapeHtml(result.error || "Thread not found.")}</div>`;
    return;
  }

  const thread = result.thread;

  if (thread.isDeleted) {
    container.innerHTML = `<div class="thread-error">This thread has been deleted.</div>`;
    return;
  }

  document.title = `${thread.title} — LifeMax.in`;

  const catLabel = CATEGORY_LABELS[thread.category] || CATEGORY_LABELS[category] || "Forum";
  const catLink = document.getElementById("breadcrumb-category");
  catLink.textContent = catLabel;
  catLink.href = `${thread.category || category}.html`;
  document.getElementById("breadcrumb-title").textContent = thread.title;

  const repliesResult = await ThreadsStore.getReplies(threadId);
  const replies = repliesResult.ok ? repliesResult.replies : [];

  const authorProfile = await getCachedUser(thread.authorUid);
  const currentUser = await AuthStore.getCurrentUser();

  container.innerHTML = `
    <div class="page-header" style="margin-bottom: 18px;">
      <div class="page-title">
        <h1 style="font-size: 19px;">${escapeHtml(thread.title)}</h1>
      </div>
    </div>

    <div id="op-post-row"></div>

    <div class="replies-heading">${replies.filter((r) => !r.isDeleted).length} repl${replies.filter((r) => !r.isDeleted).length === 1 ? "y" : "ies"}</div>
    <div id="replies-list"></div>

    <div class="reply-box">
      <h3>Post a reply</h3>
      <div id="reply-gate"></div>
      <textarea id="reply-textarea" placeholder="Write your reply..."></textarea>
      <div class="reply-image-row">
        <input type="file" id="reply-image-input" accept="image/*">
        <span class="field-hint" id="reply-image-hint"></span>
      </div>
      <button class="btn-submit-reply" id="reply-submit">Post Reply</button>
      <div class="reply-feedback" id="reply-feedback"></div>
    </div>
  `;

  renderOpPost(thread, authorProfile, currentUser);
  await renderReplies(replies, currentUser);
  await wireReplyBox();
}

function pendingDeleteBannerHtml(deleteScheduledAt, kind) {
  if (!deleteScheduledAt || deleteScheduledAt <= Date.now()) return "";
  const hrs = hoursLeft(deleteScheduledAt);
  return `
    <div class="pending-delete-banner">
      This ${kind} will be deleted in ~${hrs}h.
      <button class="undo-delete-btn" data-cancel-delete-action>Undo</button>
    </div>
  `;
}

function postRowHtml({ uid, profile, timestamp, badge, bodyHtml, imageData, likeCount, likeTargetType, likeTargetId, isOwn, deleteScheduledAt }) {
  const username = profile?.username || "Unknown";
  const bio = profile?.bio || "";
  const joined = formatDate(profile?.createdAtMs);
  const reputation = profile?.reputation ?? 0;
  const postCount = profile?.postCount ?? 0;
  const deactivated = profile?.deactivated;
  const isVip = !!profile?.isVip;
  const rankInfo = getRankInfo(reputation, profile?.rankColor);
  const glow = glowStyle(rankInfo);
  const vipBadgeHtml = isVip && !deactivated ? `<span class="vip-badge" title="VIP">VIP</span>` : "";

  // Glow/particles/badges decorate BOTH the avatar and the username text.
  const usernameHtml = deactivated
    ? `<span class="post-username" style="text-decoration: line-through; cursor: default; color: var(--text-faint);">${escapeHtml(username)}</span>`
    : `<a href="profile.html?user=${encodeURIComponent(username)}" class="post-username" style="${glow}">${escapeHtml(username)}${badgesHtml(rankInfo)}${vipBadgeHtml}</a>`;

  const pfpWrapped = deactivated
    ? pfpHtml(profile?.pfpUrl, username, "post-pfp")
    : `<span class="rank-avatar-wrap" style="${glow}">
        ${pfpHtml(profile?.pfpUrl, username, "post-pfp")}
        ${particlesHtml(rankInfo)}
      </span>`;

  const isPendingDelete = deleteScheduledAt && deleteScheduledAt > Date.now();
  const deleteBtnHtml = isOwn && !isPendingDelete
    ? `<button class="delete-post-btn" data-delete-action>Delete</button>`
    : "";

  return `
    <div class="post-row" data-like-type="${likeTargetType}" data-like-id="${escapeHtml(likeTargetId)}" data-author-uid="${escapeHtml(uid || "")}">
      <div class="post-sidebar">
        ${pfpWrapped}
        ${usernameHtml}
        ${bio ? `<div class="post-bio">${escapeHtml(bio)}</div>` : ""}
        <div class="post-sidebar-stats">
          <div class="stat-row"><span class="lbl">Joined</span><span class="val">${joined}</span></div>
          <div class="stat-row"><span class="lbl">Posts</span><span class="val">${postCount}</span></div>
          <div class="stat-row"><span class="lbl">Reputation</span><span class="val">${reputation}</span></div>
        </div>
      </div>
      <div class="post-main">
        <div class="post-main-header">
          <span>${timestamp}</span>
          <span class="post-main-header-right">
            ${badge ? `<span style="background: var(--navy); color:#fff; font-size:11px; font-weight:700; padding:2px 7px;">${badge}</span>` : ""}
            ${deleteBtnHtml}
          </span>
        </div>
        ${pendingDeleteBannerHtml(deleteScheduledAt, likeTargetType === "thread" ? "thread" : "reply")}
        <div class="post-main-body">${escapeHtml(bodyHtml)}</div>
        ${imageData ? `<div class="post-main-image"><img src="${escapeHtml(imageData)}" alt=""></div>` : ""}
        <div class="post-main-footer">
          <button class="like-btn" data-like-action>
            ${likeIconSvg} Like
          </button>
          <span class="like-count">${likeCount || 0} like${likeCount === 1 ? "" : "s"}</span>
        </div>
      </div>
    </div>
  `;
}

function renderOpPost(thread, authorProfile, currentUser) {
  const el = document.getElementById("op-post-row");
  const isOwn = currentUser && (currentUser.uid === thread.authorUid || currentUser.isVip);
  el.innerHTML = postRowHtml({
    uid: thread.authorUid,
    profile: authorProfile,
    timestamp: timeAgo(thread.createdAtMs),
    badge: "OP",
    bodyHtml: thread.description,
    imageData: thread.imageData,
    likeCount: thread.likeCount || 0,
    likeTargetType: "thread",
    likeTargetId: thread.id,
    isOwn,
    deleteScheduledAt: thread.deleteScheduledAt,
  });
  const rowEl = el.querySelector(".post-row");
  wireLikeButton(rowEl);
  wireDeleteAndCancel(rowEl, "thread", thread.id, null, () => {
    container.innerHTML = `<div class="thread-error">This thread has been deleted.</div>`;
  });
  applyInitialLikedStates([rowEl]);
}

async function renderReplies(replies, currentUser) {
  const listEl = document.getElementById("replies-list");
  const visibleReplies = replies.filter((r) => !r.isDeleted);

  if (visibleReplies.length === 0) {
    listEl.innerHTML = `<div class="thread-loading" style="padding: 20px 0;">No replies yet — be the first.</div>`;
    return;
  }

  // Fetch all author profiles in parallel (cached, so repeats are free)
  const profiles = await Promise.all(visibleReplies.map((r) => getCachedUser(r.authorUid)));

  listEl.innerHTML = visibleReplies
    .map((r, i) => {
      const isOwn = currentUser && (currentUser.uid === r.authorUid || currentUser.isVip);
      return postRowHtml({
        uid: r.authorUid,
        profile: profiles[i],
        timestamp: timeAgo(r.createdAtMs),
        badge: "",
        bodyHtml: r.body,
        imageData: r.imageData,
        likeCount: r.likeCount || 0,
        likeTargetType: "reply",
        likeTargetId: r.id,
        isOwn,
        deleteScheduledAt: r.deleteScheduledAt,
      });
    })
    .join("");

  listEl.querySelectorAll(".post-row").forEach((rowEl, i) => {
    wireLikeButton(rowEl);
    const reply = visibleReplies[i];
    wireDeleteAndCancel(rowEl, "reply", reply.id, threadId, () => {
      rowEl.remove();
    });
  });

  applyInitialLikedStates(Array.from(listEl.querySelectorAll(".post-row")));
}

function wireLikeButton(postRowEl) {
  if (!postRowEl) return;
  const likeBtn = postRowEl.querySelector("[data-like-action]");
  const likeCountEl = postRowEl.querySelector(".like-count");
  const likeType = postRowEl.dataset.likeType;
  const likeId = postRowEl.dataset.likeId;
  const authorUid = postRowEl.dataset.authorUid;

  likeBtn.addEventListener("click", async () => {
    const allowed = await requirePostingAccess();
    if (!allowed) return;

    likeBtn.disabled = true;
    const currentUser = await AuthStore.getCurrentUser();
    const currentUid = currentUser ? currentUser.uid : null;

    let result;
    if (likeType === "thread") {
      result = await ThreadsStore.likeThread(likeId, authorUid, currentUid);
    } else {
      result = await ThreadsStore.likeReply(threadId, likeId, authorUid, currentUid);
    }
    likeBtn.disabled = false;

    if (result.ok) {
      const delta = result.liked ? 1 : -1;
      const current = parseInt(likeCountEl.textContent, 10) || 0;
      const next = Math.max(0, current + delta);
      likeCountEl.textContent = `${next} like${next === 1 ? "" : "s"}`;
      setLikedVisualState(likeBtn, result.liked);

      if (authorUid && currentUid !== authorUid) {
        const repEl = postRowEl.querySelector(".post-sidebar-stats .stat-row:last-child .val");
        if (repEl) repEl.textContent = Math.max(0, (parseInt(repEl.textContent, 10) || 0) + delta);
        userCache.delete(authorUid);
      }
    }
  });
}

function setLikedVisualState(likeBtn, liked) {
  likeBtn.classList.toggle("liked", liked);
  likeBtn.innerHTML = `${likeIconSvg} ${liked ? "Liked" : "Like"}`;
}

/**
 * Checks whether the current user has already liked each visible
 * post and reply, setting the Like button's initial visual state
 * accordingly. Called once per render after the like buttons exist.
 */
async function applyInitialLikedStates(rows) {
  const currentUser = await AuthStore.getCurrentUser();
  if (!currentUser) return;

  await Promise.all(
    rows.map(async (rowEl) => {
      const likeType = rowEl.dataset.likeType;
      const likeId = rowEl.dataset.likeId;
      const liked =
        likeType === "thread"
          ? await ThreadsStore.hasLikedThread(likeId, currentUser.uid)
          : await ThreadsStore.hasLikedReply(threadId, likeId, currentUser.uid);
      if (liked) {
        const likeBtn = rowEl.querySelector("[data-like-action]");
        if (likeBtn) setLikedVisualState(likeBtn, true);
      }
    })
  );
}

/**
 * Wires both the Delete button and (if a pending-delete banner is
 * present) the Undo button for a single post row, re-wiring itself
 * after each state transition so the row stays interactive without
 * needing a full page reload.
 */
function wireDeleteAndCancel(postRowEl, kind, id, parentThreadId, onPermanentRemove) {
  function wireDelete() {
    const btn = postRowEl.querySelector("[data-delete-action]");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const confirmed = window.confirm(
        `Delete this ${kind}? It will be permanently removed in 24 hours unless you undo it before then.`
      );
      if (!confirmed) return;

      btn.disabled = true;
      const result =
        kind === "thread"
          ? await ThreadsStore.scheduleThreadDeletion(id)
          : await ThreadsStore.scheduleReplyDeletion(parentThreadId, id);

      if (!result.ok) {
        alert(result.error || "Could not delete. Please try again.");
        btn.disabled = false;
        return;
      }

      if (kind === "thread") {
        onPermanentRemove();
        return;
      }

      const deleteScheduledAt = Date.now() + ThreadsStore.DELETE_DELAY_MS;
      const headerRight = postRowEl.querySelector(".post-main-header-right");
      btn.remove();
      const header = postRowEl.querySelector(".post-main-header");
      header.insertAdjacentHTML("afterend", pendingDeleteBannerHtml(deleteScheduledAt, "reply"));
      wireCancel();
    });
  }

  function wireCancel() {
    const cancelBtn = postRowEl.querySelector("[data-cancel-delete-action]");
    if (!cancelBtn) return;
    cancelBtn.addEventListener("click", async () => {
      cancelBtn.disabled = true;
      const result =
        kind === "thread"
          ? await ThreadsStore.cancelThreadDeletion(id)
          : await ThreadsStore.cancelReplyDeletion(parentThreadId, id);

      if (!result.ok) {
        alert(result.error || "Could not undo deletion. Please try again.");
        cancelBtn.disabled = false;
        return;
      }

      const banner = postRowEl.querySelector(".pending-delete-banner");
      if (banner) banner.remove();
      const headerRight = postRowEl.querySelector(".post-main-header-right");
      if (headerRight && !headerRight.querySelector("[data-delete-action]")) {
        headerRight.insertAdjacentHTML("beforeend", `<button class="delete-post-btn" data-delete-action>Delete</button>`);
        wireDelete();
      }
    });
  }

  wireDelete();
  wireCancel();
}

/**
 * Resize an image file down to maxWidth x maxHeight (preserving
 * aspect ratio, capped) and return it as a compressed JPEG data URL.
 */
function resizeImageToDataUrl(file, maxWidth, maxHeight) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not load image."));
      img.onload = () => {
        const ratio = Math.min(maxWidth / img.width, maxHeight / img.height, 1);
        const targetW = Math.round(img.width * ratio);
        const targetH = Math.round(img.height * ratio);

        const canvas = document.createElement("canvas");
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, targetW, targetH);

        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function wireReplyBox() {
  const gateEl = document.getElementById("reply-gate");
  const textarea = document.getElementById("reply-textarea");
  const submitBtn = document.getElementById("reply-submit");
  const feedbackEl = document.getElementById("reply-feedback");
  const imageInput = document.getElementById("reply-image-input");
  const imageHint = document.getElementById("reply-image-hint");

  let pendingImageData = "";

  imageInput.addEventListener("change", async () => {
    const file = imageInput.files[0];
    if (!file) return;
    try {
      pendingImageData = await resizeImageToDataUrl(file, 800, 800);
      imageHint.textContent = "Image attached.";
    } catch (e) {
      imageHint.textContent = "Could not process that image.";
      pendingImageData = "";
    }
  });

  async function updateGateNote() {
    const status = await AuthStore.getQueueStatus();
    if (!status.loggedIn) {
      gateEl.innerHTML = `<p class="reply-gate-note">You need an account to reply. <a href="#" data-auth-open="login">Log in</a> or <a href="#" data-auth-open="signup">register</a> first.</p>`;
      attachAuthOpenHandlers(gateEl);
    } else if (!status.ready) {
      const s = Math.ceil(status.msLeft / 1000);
      gateEl.innerHTML = `<p class="reply-gate-note">Your account is still in the queue — you can reply in ${s}s.</p>`;
    } else {
      gateEl.innerHTML = "";
    }
    return status;
  }

  function attachAuthOpenHandlers(scope) {
    scope.querySelectorAll("[data-auth-open]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        document.getElementById("auth-overlay").classList.add("open");
        document.querySelectorAll(".auth-tab").forEach((t) =>
          t.classList.toggle("active", t.dataset.tab === el.dataset.authOpen)
        );
        document.getElementById("panel-login").classList.toggle("active", el.dataset.authOpen === "login");
        document.getElementById("panel-signup").classList.toggle("active", el.dataset.authOpen === "signup");
      });
    });
  }

  await updateGateNote();

  submitBtn.addEventListener("click", async () => {
    feedbackEl.classList.remove("show", "error", "success");

    const allowed = await requirePostingAccess();
    if (!allowed) {
      await updateGateNote();
      return;
    }

    const body = textarea.value.trim();
    if (body.length < 1) {
      feedbackEl.textContent = "Reply can't be empty.";
      feedbackEl.classList.add("show", "error");
      return;
    }

    submitBtn.disabled = true;
    const user = await AuthStore.getCurrentUser();
    const result = await ThreadsStore.addReply(threadId, {
      body,
      authorUid: user.uid,
      authorUsername: user.username,
      imageData: pendingImageData,
    });
    submitBtn.disabled = false;

    if (!result.ok) {
      feedbackEl.textContent = result.error;
      feedbackEl.classList.add("show", "error");
      return;
    }

    textarea.value = "";
    pendingImageData = "";
    imageInput.value = "";
    imageHint.textContent = "";
    feedbackEl.textContent = "Reply posted.";
    feedbackEl.classList.add("show", "success");

    const repliesResult = await ThreadsStore.getReplies(threadId);
    if (repliesResult.ok) {
      const freshUser = await AuthStore.getCurrentUser();
      await renderReplies(repliesResult.replies, freshUser);
      const visibleCount = repliesResult.replies.filter((r) => !r.isDeleted).length;
      document.querySelector(".replies-heading").textContent = `${visibleCount} repl${visibleCount === 1 ? "y" : "ies"}`;
    }
  });

  setInterval(updateGateNote, 5000);
}

init();
