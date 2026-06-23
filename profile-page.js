// ============================================================
// LifeMax.in — Profile Page Controller
// ------------------------------------------------------------
// Reads ?user=username from the URL, loads that user's public
// profile data + their threads, and renders the sidebar-card
// layout (avatar, username, Joined/Posts/Reputation) alongside
// their thread list. If the logged-in viewer IS this user, shows
// an "Edit Profile" button (bio/pfp), a rank color picker, and a
// Deactivate Account option.
// ============================================================

import { AuthStore } from "./auth-firebase.js";
import { ThreadsStore } from "./threads-firebase.js";
import { getRankInfo, glowStyle, badgesHtml, particlesHtml, RANK_COLORS } from "./rank-system.js";

const CATEGORY_LABELS = {
  bestofthebest: "Best of the Best",
  socialmaxing: "Socialmaxing",
  academicmaxing: "Academicmaxing",
  lifestylemaxing: "Lifestylemaxing",
  statusmax: "Status Max",
};

const params = new URLSearchParams(window.location.search);
const usernameParam = params.get("user") || "";
const container = document.getElementById("profile-container");
const breadcrumbEl = document.getElementById("breadcrumb-username");

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

function initialPfpHtml(username, cls) {
  const initial = (username || "?").trim().charAt(0).toUpperCase() || "?";
  return `<div class="${cls} pfp-initial">${escapeHtml(initial)}</div>`;
}

function pfpHtml(pfpUrl, username, cls) {
  const c = cls || "profile-pfp";
  if (pfpUrl) {
    return `<img class="${c}" src="${escapeHtml(pfpUrl)}" alt="" onerror='this.outerHTML=${JSON.stringify(initialPfpHtml(username, c))}'>`;
  }
  return initialPfpHtml(username, c);
}

async function init() {
  if (!usernameParam) {
    container.innerHTML = `<div class="profile-error">No user specified.</div>`;
    return;
  }

  const profileUser = await AuthStore.getUserByUsername(usernameParam);
  if (!profileUser) {
    container.innerHTML = `<div class="profile-error">No user found with that username. They may have deactivated their account.</div>`;
    return;
  }

  document.title = `${profileUser.username} — LifeMax.in`;
  breadcrumbEl.textContent = profileUser.username;

  const threadsResult = await ThreadsStore.getThreadsByAuthor(profileUser.uid);
  const threads = (threadsResult.ok ? threadsResult.threads : []).filter((t) => !t.isDeleted);

  const currentUser = await AuthStore.getCurrentUser();
  const isOwnProfile = currentUser && currentUser.uid === profileUser.uid;

  renderProfile(profileUser, threads, isOwnProfile);
}

function renderProfile(profileUser, threads, isOwnProfile) {
  const rankInfo = getRankInfo(profileUser.reputation, profileUser.rankColor);
  const glow = glowStyle(rankInfo);

  container.innerHTML = `
    <div class="profile-grid">
      <div class="profile-card">
        <span class="rank-avatar-wrap" style="${glow}">
          ${pfpHtml(profileUser.pfpUrl, profileUser.username, "profile-pfp")}
          ${particlesHtml(rankInfo)}
        </span>
        <h2 style="${glow}">${escapeHtml(profileUser.username)}${badgesHtml(rankInfo)}${profileUser.isVip && !profileUser.deactivated ? '<span class="vip-badge" title="VIP">VIP</span>' : ""}</h2>
        <p class="profile-bio" id="profile-bio-display">${profileUser.bio ? escapeHtml(profileUser.bio) : "<em style=\"color:var(--text-faint);\">No bio yet.</em>"}</p>
        <div class="profile-stats-list">
          <div class="stat-row"><span class="lbl">Joined</span><span class="val">${formatDate(profileUser.createdAtMs)}</span></div>
          <div class="stat-row"><span class="lbl">Posts</span><span class="val">${profileUser.postCount || 0}</span></div>
          <div class="stat-row"><span class="lbl">Reputation</span><span class="val">${profileUser.reputation}</span></div>
        </div>
        ${isOwnProfile
          ? `<button class="profile-edit-btn" id="edit-profile-btn">Edit Profile</button>`
          : `<a href="messages.html?with=${encodeURIComponent(profileUser.username)}" class="profile-edit-btn" id="message-user-btn" style="display:block; text-align:center; text-decoration:none;">Message</a>`}
      </div>

      <div class="profile-main-block" id="profile-main-block">
        ${threadsListHtml(threads)}
      </div>
    </div>
  `;

  if (isOwnProfile) {
    document.getElementById("edit-profile-btn").addEventListener("click", () => {
      renderEditForm(profileUser, threads);
    });
  }
}

function threadsListHtml(threads) {
  if (threads.length === 0) {
    return `<h3>Threads</h3><p style="color: var(--text-faint); font-size: 13.5px;">No threads posted yet.</p>`;
  }
  return `
    <h3>Threads</h3>
    <div class="profile-threads-list">
      ${threads
        .map((t) => {
          const url = `thread.html?id=${encodeURIComponent(t.id)}&category=${encodeURIComponent(t.category)}`;
          const catLabel = CATEGORY_LABELS[t.category] || t.category;
          return `
          <div class="my-thread-row">
            <div>
              <a href="${url}" class="thread-title">${escapeHtml(t.title)}</a>
              <span class="thread-cat">${escapeHtml(catLabel)}</span>
            </div>
            <div class="thread-stat">${t.replyCount || 0} replies</div>
            <div class="thread-when">${timeAgo(t.createdAtMs)}</div>
          </div>
        `;
        })
        .join("")}
    </div>
  `;
}

function colorPickerHtml(currentColor) {
  return `
    <div class="form-field">
      <label>Rank color</label>
      <div class="rank-color-picker" id="rank-color-picker">
        ${Object.entries(RANK_COLORS)
          .map(
            ([key, hex]) =>
              `<div class="rank-color-swatch ${key === currentColor ? "selected" : ""}" data-color="${key}" style="background:${hex};" title="${key}"></div>`
          )
          .join("")}
      </div>
      <div class="field-hint">Shows once you reach 100 reputation. Affects your glow/particle color everywhere.</div>
    </div>
  `;
}

function renderEditForm(profileUser, threads) {
  const mainBlock = document.getElementById("profile-main-block");
  mainBlock.innerHTML = `
    <h3>Edit Profile</h3>
    <div class="edit-profile-form">
      <div class="form-error" id="edit-error"></div>
      <div class="form-field">
        <label for="edit-pfp-file">Profile picture</label>
        <div style="display:flex; align-items:center; gap:14px; margin-bottom: 8px;">
          ${pfpHtml(profileUser.pfpUrl, profileUser.username, "profile-pfp")}
          <input type="file" id="edit-pfp-file" accept="image/*">
        </div>
        <div class="field-hint">JPG, PNG, or GIF. Large images are automatically resized.</div>
      </div>
      <div class="form-field">
        <label for="edit-bio">Bio</label>
        <textarea id="edit-bio" maxlength="50" placeholder="Tell people a bit about yourself...">${escapeHtml(profileUser.bio || "")}</textarea>
        <div class="field-hint">Up to 50 characters.</div>
      </div>
      ${colorPickerHtml(profileUser.rankColor || "gold")}
      <div class="btn-row">
        <button class="btn-save" id="save-profile-btn">Save Changes</button>
        <button class="btn-cancel" id="cancel-edit-btn">Cancel</button>
      </div>
    </div>

    <div class="danger-zone">
      <h3 style="color: var(--tag-serious-text);">Deactivate Account</h3>
      <p class="field-hint" style="margin-bottom: 12px;">
        Your threads and replies stay exactly as they are, but your profile becomes unsearchable and
        your username appears struck through wherever it's shown. This cannot be undone from this page.
      </p>
      <button class="btn-danger" id="deactivate-btn">Deactivate My Account</button>
    </div>
  `;

  let pendingPfpData = profileUser.pfpUrl || "";
  let pendingColor = profileUser.rankColor || "gold";

  const fileInput = document.getElementById("edit-pfp-file");
  const previewImg = mainBlock.querySelector(".profile-pfp");

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;

    const errorEl = document.getElementById("edit-error");
    errorEl.classList.remove("show");

    try {
      const resizedDataUrl = await resizeImageToDataUrl(file, 200, 200);
      pendingPfpData = resizedDataUrl;
      if (previewImg && previewImg.tagName === "IMG") {
        previewImg.src = resizedDataUrl;
      } else if (previewImg) {
        const img = document.createElement("img");
        img.className = previewImg.className;
        img.src = resizedDataUrl;
        previewImg.replaceWith(img);
      }
    } catch (e) {
      errorEl.textContent = "Could not process that image. Try a different file.";
      errorEl.classList.add("show");
    }
  });

  document.getElementById("rank-color-picker").addEventListener("click", (e) => {
    const swatch = e.target.closest(".rank-color-swatch");
    if (!swatch) return;
    pendingColor = swatch.dataset.color;
    document.querySelectorAll(".rank-color-swatch").forEach((s) => s.classList.toggle("selected", s === swatch));
  });

  document.getElementById("cancel-edit-btn").addEventListener("click", () => {
    mainBlock.innerHTML = threadsListHtml(threads);
  });

  document.getElementById("save-profile-btn").addEventListener("click", async () => {
    const errorEl = document.getElementById("edit-error");
    errorEl.classList.remove("show");

    const bio = document.getElementById("edit-bio").value.trim();
    const saveBtn = document.getElementById("save-profile-btn");
    saveBtn.disabled = true;

    const profileResult = await AuthStore.updateProfile(profileUser.uid, { bio, pfpUrl: pendingPfpData });
    const colorResult = await AuthStore.updateRankColor(profileUser.uid, pendingColor);
    saveBtn.disabled = false;

    if (!profileResult.ok) {
      errorEl.textContent = profileResult.error;
      errorEl.classList.add("show");
      return;
    }
    if (!colorResult.ok) {
      errorEl.textContent = colorResult.error;
      errorEl.classList.add("show");
      return;
    }

    profileUser.bio = bio;
    profileUser.pfpUrl = pendingPfpData;
    profileUser.rankColor = pendingColor;
    renderProfile(profileUser, threads, true);
  });

  document.getElementById("deactivate-btn").addEventListener("click", async () => {
    const confirmed = window.confirm(
      "Are you sure? Your account will be deactivated — your posts stay, but your profile becomes unsearchable. This cannot be undone here."
    );
    if (!confirmed) return;

    const btn = document.getElementById("deactivate-btn");
    btn.disabled = true;
    const result = await AuthStore.deactivateAccount(profileUser.uid);
    if (!result.ok) {
      alert(result.error || "Could not deactivate account.");
      btn.disabled = false;
      return;
    }
    window.location.href = "index.html";
  });
}

/**
 * Resize an image file down to maxWidth x maxHeight (preserving
 * aspect ratio, cropped to a square) and return it as a compressed
 * JPEG data URL.
 */
function resizeImageToDataUrl(file, maxWidth, maxHeight) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not load image."));
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;

        const canvas = document.createElement("canvas");
        canvas.width = maxWidth;
        canvas.height = maxHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, sx, sy, side, side, 0, 0, maxWidth, maxHeight);

        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

init();
