// ============================================================
// LifeMax.in — Auth UI Controller (Firebase version)
// ------------------------------------------------------------
// Wires the login/signup modal, topbar account pill, and the
// posting gate to the Firebase-backed AuthStore. Same behavior
// as the old localStorage version: signup shows a queue screen
// that auto-closes after 10s, and posting is gated until 1
// minute after signup.
//
// VIP SETUP: paste your real Stripe Payment Link URL below once
// you have it. In Stripe's Payment Link settings, set the
// "After payment" confirmation page to redirect to:
//   https://lifemax.in/vip-success.html
// That page is what actually grants VIP — reaching it is only
// possible by completing checkout via the link below.
//
// Include as: <script type="module" src="auth-ui.js"></script>
// ============================================================

import { AuthStore } from "./auth-firebase.js";

const STRIPE_PAYMENT_LINK_URL = "PASTE_YOUR_STRIPE_PAYMENT_LINK_HERE";

const overlay = document.getElementById("auth-overlay");
const closeBtn = document.getElementById("auth-close");
const tabs = document.querySelectorAll(".auth-tab");
const panelLogin = document.getElementById("panel-login");
const panelSignup = document.getElementById("panel-signup");
const panelQueue = document.getElementById("panel-queue");
const loginError = document.getElementById("login-error");
const signupError = document.getElementById("signup-error");
const gateToast = document.getElementById("gate-toast");

let gateToastTimer = null;

function openModal(tab) {
  overlay.classList.add("open");
  showTab(tab || "login");
}
function closeModal() {
  overlay.classList.remove("open");
  panelLogin.style.display = "";
  panelSignup.style.display = "";
  document.getElementById("auth-tabs").style.display = "";
  panelQueue.style.display = "none";
  loginError.classList.remove("show");
  signupError.classList.remove("show");
}

function showTab(name) {
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  panelLogin.classList.toggle("active", name === "login");
  panelSignup.classList.toggle("active", name === "signup");
}

tabs.forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
closeBtn.addEventListener("click", closeModal);
overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

function attachAuthOpenHandlers(scope) {
  scope.querySelectorAll("[data-auth-open]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      openModal(el.dataset.authOpen);
    });
  });
}
attachAuthOpenHandlers(document);

function showError(panel, message) {
  panel.textContent = message;
  panel.classList.add("show");
}

// ---------- Login ----------
panelLogin.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.classList.remove("show");
  const username = document.getElementById("login-username").value;
  const password = document.getElementById("login-password").value;
  const submitBtn = panelLogin.querySelector(".auth-submit");
  submitBtn.disabled = true;

  const result = await AuthStore.logIn(username, password);
  submitBtn.disabled = false;

  if (!result.ok) {
    showError(loginError, result.error);
    return;
  }
  closeModal();
  await refreshAccountUI();
});

// ---------- Sign up ----------
panelSignup.addEventListener("submit", async (e) => {
  e.preventDefault();
  signupError.classList.remove("show");
  const username = document.getElementById("signup-username").value;
  const password = document.getElementById("signup-password").value;
  const submitBtn = panelSignup.querySelector(".auth-submit");
  submitBtn.disabled = true;

  const result = await AuthStore.signUp(username, password);
  submitBtn.disabled = false;

  if (!result.ok) {
    showError(signupError, result.error);
    return;
  }

  showQueueScreen();
  await refreshAccountUI();
});

function showQueueScreen() {
  document.getElementById("auth-tabs").style.display = "none";
  panelLogin.style.display = "none";
  panelSignup.style.display = "none";
  panelQueue.style.display = "block";

  let secondsLeft = 10;
  const countdownEl = document.getElementById("queue-countdown");
  countdownEl.textContent = secondsLeft;
  const interval = setInterval(() => {
    secondsLeft -= 1;
    if (secondsLeft <= 0) {
      clearInterval(interval);
      closeModal();
      refreshAccountUI();
      return;
    }
    countdownEl.textContent = secondsLeft;
  }, 1000);
}

// ---------- Sign in / up with Google ----------
async function handleGoogleAuth(button, errorPanel) {
  errorPanel.classList.remove("show");
  button.disabled = true;

  const result = await AuthStore.signInWithGoogle();
  button.disabled = false;

  if (!result.ok) {
    showError(errorPanel, result.error);
    return;
  }

  if (result.isNewAccount) {
    // Brand new account via Google — same 1-minute queue as a normal signup.
    showQueueScreen();
  } else {
    // Returning Google account — already passed the queue previously.
    closeModal();
  }
  await refreshAccountUI();
}

document.getElementById("google-signin-btn")?.addEventListener("click", () => {
  handleGoogleAuth(document.getElementById("google-signin-btn"), loginError);
});
document.getElementById("google-signup-btn")?.addEventListener("click", () => {
  handleGoogleAuth(document.getElementById("google-signup-btn"), signupError);
});


// ---------- Topbar account pill ----------
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

let queueTickInterval = null;

export async function refreshAccountUI() {
  const status = await AuthStore.getQueueStatus();
  const slot = document.getElementById("account-slot");
  if (!slot) return status;

  if (queueTickInterval) {
    clearInterval(queueTickInterval);
    queueTickInterval = null;
  }

  if (!status.loggedIn) {
    slot.innerHTML = `
      <a href="#" class="topbar-link" data-auth-open="login">Log in</a>
      <a href="#" class="btn-register" data-auth-open="signup">Register</a>
    `;
    attachAuthOpenHandlers(slot);
    return status;
  }

  if (status.ready) {
    const pfpHtml = status.user.pfpUrl
      ? `<img src="${escapeHtml(status.user.pfpUrl)}" alt="" class="acc-pfp" onerror="this.style.display='none'">`
      : `<span class="acc-pfp acc-pfp-initial">${escapeHtml((status.user.username || "?").charAt(0).toUpperCase())}</span>`;
    const vipButtonHtml = !status.user.isVip
      ? `<a href="${STRIPE_PAYMENT_LINK_URL}" class="acc-get-vip-btn" target="_blank" rel="noopener">Get VIP</a>`
      : "";
    slot.innerHTML = `
      <div class="account-pill">
        <a href="profile.html?user=${encodeURIComponent(status.user.username)}" class="acc-pfp-link" title="View your profile">${pfpHtml}</a>
        <a href="profile.html?user=${encodeURIComponent(status.user.username)}" class="acc-name" style="cursor:pointer;">${escapeHtml(status.user.username)}</a>
        <span class="acc-status active">Active</span>
        ${vipButtonHtml}
        <button class="acc-logout" id="acc-logout-btn">Log out</button>
      </div>
    `;
  } else {
    const secondsLeft = Math.ceil(status.msLeft / 1000);
    slot.innerHTML = `
      <div class="account-pill">
        <span class="acc-name">${escapeHtml(status.user.username)}</span>
        <span class="acc-status in-queue" id="acc-queue-label">In queue · ${secondsLeft}s</span>
        <button class="acc-logout" id="acc-logout-btn">Log out</button>
      </div>
    `;
    queueTickInterval = setInterval(async () => {
      const s = await AuthStore.getQueueStatus();
      if (!s.loggedIn) { clearInterval(queueTickInterval); return; }
      if (s.ready) {
        clearInterval(queueTickInterval);
        refreshAccountUI();
        return;
      }
      const label = document.getElementById("acc-queue-label");
      if (label) label.textContent = `In queue · ${Math.ceil(s.msLeft / 1000)}s`;
    }, 1000);
  }

  document.getElementById("acc-logout-btn")?.addEventListener("click", async () => {
    await AuthStore.logOut();
    refreshAccountUI();
  });

  return status;
}

// ---------- Gate toast ----------
function showGateToast(message) {
  gateToast.innerHTML = message;
  gateToast.classList.add("show");
  if (gateToastTimer) clearTimeout(gateToastTimer);
  gateToastTimer = setTimeout(() => gateToast.classList.remove("show"), 3200);
  attachAuthOpenHandlers(gateToast);
}

/**
 * Call before any posting/reply action.
 * Returns true if allowed, false otherwise (shows a toast explaining why).
 */
export async function requirePostingAccess() {
  const status = await AuthStore.getQueueStatus();
  if (!status.loggedIn) {
    showGateToast(`You need an account to do that. <a href="#" data-auth-open="login">Log in</a> or <a href="#" data-auth-open="signup">register</a>.`);
    return false;
  }
  if (!status.ready) {
    const secondsLeft = Math.ceil(status.msLeft / 1000);
    showGateToast(`Your account is still in the queue — ${secondsLeft}s left before you can post.`);
    return false;
  }
  return true;
}

window.requirePostingAccess = requirePostingAccess;
window.refreshAccountUI = refreshAccountUI;
window.AuthStore = AuthStore;

// Wire up "New Thread" buttons (link, not gated alert — gate happens on the new-thread page itself too)
document.querySelectorAll(".btn-new-thread").forEach((btn) => {
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    const allowed = await requirePostingAccess();
    if (allowed) {
      const category = btn.dataset.category || "";
      window.location.href = `new-thread.html?category=${encodeURIComponent(category)}`;
    }
  });
});

// Init
refreshAccountUI();
