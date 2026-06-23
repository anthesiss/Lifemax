// ============================================================
// LifeMax.in — New Thread Page Controller
// ------------------------------------------------------------
// Reads ?category= from the URL. If the user isn't logged in or
// is still in the posting queue, shows a gate message instead of
// the form. Otherwise renders the title/description form (with
// an optional image upload) and creates the thread in Firestore
// on submit, then redirects to the new thread's page.
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

const params = new URLSearchParams(window.location.search);
const category = params.get("category") || "";
const formContainer = document.getElementById("form-container");
const categoryLabelEl = document.getElementById("category-label");
const breadcrumbCategoryEl = document.getElementById("breadcrumb-category");

const label = CATEGORY_LABELS[category] || "this forum";
categoryLabelEl.textContent = label;
breadcrumbCategoryEl.textContent = label;
breadcrumbCategoryEl.href = category ? `${category}.html` : "index.html";

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

async function render() {
  const status = await AuthStore.getQueueStatus();

  if (!status.loggedIn) {
    formContainer.innerHTML = `
      <div class="gate-block">
        <p>You need an account to start a thread. <a href="#" data-auth-open="login">Log in</a> or <a href="#" data-auth-open="signup">register</a> first.</p>
      </div>
    `;
    wireGateLinks();
    return;
  }

  if (!status.ready) {
    const secondsLeft = Math.ceil(status.msLeft / 1000);
    formContainer.innerHTML = `
      <div class="gate-block">
        <p>Your account is still in the queue — you can post in about ${secondsLeft}s. Feel free to keep this tab open; it'll update automatically.</p>
      </div>
    `;
    setTimeout(render, 2000);
    return;
  }

  if (!category) {
    formContainer.innerHTML = `
      <div class="gate-block">
        <p>No forum category was specified. Go back to a forum and click "New Thread" from there.</p>
      </div>
    `;
    return;
  }

  formContainer.innerHTML = `
    <div class="new-thread-form">
      <div class="form-error" id="form-error"></div>
      <div class="form-field">
        <label for="thread-title">Title</label>
        <input type="text" id="thread-title" placeholder="Give your thread a clear title" maxlength="120">
        <div class="field-hint">At least 5 characters.</div>
      </div>
      <div class="form-field">
        <label for="thread-description">Description</label>
        <textarea id="thread-description" placeholder="What do you want to say?"></textarea>
        <div class="field-hint">At least 10 characters.</div>
      </div>
      <div class="form-field">
        <label for="thread-image">Image (optional)</label>
        <input type="file" id="thread-image" accept="image/*">
        <div class="field-hint" id="thread-image-hint">Attach a picture to your post if you'd like.</div>
      </div>
      <button class="btn-submit-thread" id="thread-submit">Post Thread</button>
    </div>
  `;

  let pendingImageData = "";
  document.getElementById("thread-image").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    const hintEl = document.getElementById("thread-image-hint");
    if (!file) return;
    try {
      pendingImageData = await resizeImageToDataUrl(file, 800, 800);
      hintEl.textContent = "Image attached.";
    } catch (err) {
      hintEl.textContent = "Could not process that image.";
      pendingImageData = "";
    }
  });

  document.getElementById("thread-submit").addEventListener("click", async () => {
    const errorEl = document.getElementById("form-error");
    errorEl.classList.remove("show");

    const title = document.getElementById("thread-title").value;
    const description = document.getElementById("thread-description").value;
    const submitBtn = document.getElementById("thread-submit");
    submitBtn.disabled = true;

    const user = await AuthStore.getCurrentUser();
    if (!user) {
      errorEl.textContent = "You're no longer logged in. Please log in again.";
      errorEl.classList.add("show");
      submitBtn.disabled = false;
      return;
    }

    const result = await ThreadsStore.createThread({
      category,
      title,
      description,
      authorUid: user.uid,
      authorUsername: user.username,
      imageData: pendingImageData,
    });

    submitBtn.disabled = false;

    if (!result.ok) {
      errorEl.textContent = result.error;
      errorEl.classList.add("show");
      return;
    }

    window.location.href = `thread.html?id=${encodeURIComponent(result.id)}&category=${encodeURIComponent(category)}`;
  });
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

function wireGateLinks() {
  formContainer.querySelectorAll("[data-auth-open]").forEach((el) => {
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

// Re-render the gate/form whenever login or signup succeeds via the modal
document.getElementById("panel-login")?.addEventListener("submit", () => setTimeout(render, 300));
document.getElementById("panel-signup")?.addEventListener("submit", () => setTimeout(render, 300));

render();
