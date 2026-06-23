// ============================================================
// LifeMax.in — VIP Success Page Controller
// ------------------------------------------------------------
// This page is the "after payment" redirect target configured on
// the Stripe Payment Link. Simply reaching this page while logged
// in grants VIP — there's no server-side payment verification yet
// (that would need a Stripe webhook + a paid Firebase plan), so
// this is an honor-system check: the only way someone normally
// reaches this exact URL is by actually completing checkout via
// the Payment Link's configured redirect.
// ============================================================

import { AuthStore } from "./auth-firebase.js";

const block = document.getElementById("vip-success-block");

const vipIconSvg = `<svg class="vip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l2.4 7.2H22l-6 4.6 2.3 7.2L12 16.8 5.7 21l2.3-7.2-6-4.6h7.6z"/></svg>`;

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function wireAuthLinks() {
  block.querySelectorAll("[data-auth-open]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById("auth-overlay").classList.add("open");
      const tab = el.dataset.authOpen;
      document.querySelectorAll(".auth-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
      document.getElementById("panel-login").classList.toggle("active", tab === "login");
      document.getElementById("panel-signup").classList.toggle("active", tab === "signup");
    });
  });
}

async function init() {
  const currentUser = await AuthStore.getCurrentUser();

  if (!currentUser) {
    block.innerHTML = `
      ${vipIconSvg}
      <h2>Almost there</h2>
      <p>Thanks for your payment! Please log in to the account you want VIP applied to, then revisit this page.</p>
      <a href="index.html" class="btn-go-home" data-auth-open="login">Log In</a>
    `;
    wireAuthLinks();
    return;
  }

  if (currentUser.isVip) {
    block.innerHTML = `
      ${vipIconSvg}
      <h2>You're already VIP</h2>
      <p>Your account already has VIP perks active. Thanks for your support!</p>
      <a href="index.html" class="btn-go-home">Back to Forums</a>
    `;
    return;
  }

  const result = await AuthStore.grantVip(currentUser.uid);

  if (!result.ok) {
    block.innerHTML = `
      ${vipIconSvg}
      <h2>Something went wrong</h2>
      <p>We couldn't activate VIP automatically. Please refresh this page, or contact support if it keeps happening.</p>
      <a href="index.html" class="btn-go-home">Back to Forums</a>
    `;
    return;
  }

  block.innerHTML = `
    ${vipIconSvg}
    <h2>Welcome to VIP, ${escapeHtml(currentUser.username)}!</h2>
    <p>Your account now has the VIP badge, the ability to delete any thread or comment, and your new threads will be featured on the homepage.</p>
    <a href="index.html" class="btn-go-home">Back to Forums</a>
  `;
}

init();
