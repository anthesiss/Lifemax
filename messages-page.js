// ============================================================
// LifeMax.in — Messages Page Controller
// ------------------------------------------------------------
// Renders the inbox (left) and active conversation (right). If the
// URL has ?with=username, opens (or starts) a conversation with
// that user directly — this is what the "Message" button on a
// profile page links to. Otherwise shows the most recent
// conversation, or an empty state if there are none yet.
// ============================================================

import { AuthStore } from "./auth-firebase.js";
import { MessagingStore } from "./messaging-firebase.js";

const container = document.getElementById("messages-container");
const params = new URLSearchParams(window.location.search);
const withUsernameParam = params.get("with") || "";

let currentUser = null;
let activeConversationId = null;
let unsubscribeFromMessages = null;

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function timeAgo(ms) {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "now";
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d`;
  const month = Math.floor(day / 30);
  return `${month}mo`;
}

function otherParticipant(conversation, myUid) {
  const otherUid = conversation.participants.find((uid) => uid !== myUid);
  return {
    uid: otherUid,
    username: conversation.participantUsernames?.[otherUid] || "Unknown",
  };
}

async function init() {
  currentUser = await AuthStore.getCurrentUser();

  if (!currentUser) {
    container.innerHTML = `
      <div class="messages-layout">
        <div class="conv-no-selection" style="grid-column: 1 / -1;">
          You need to be logged in to view messages. <a href="#" data-auth-open="login" style="margin-left:6px;">Log in</a>
        </div>
      </div>
    `;
    wireAuthLinks(container);
    return;
  }

  const convResult = await MessagingStore.getConversationsForUser(currentUser.uid);
  const conversations = convResult.ok ? convResult.conversations : [];

  renderLayout(conversations);

  if (withUsernameParam) {
    const targetUser = await AuthStore.getUserByUsername(withUsernameParam);
    if (targetUser && targetUser.uid !== currentUser.uid) {
      const conversationId = MessagingStore.conversationIdFor(currentUser.uid, targetUser.uid);
      openConversation(conversationId, { uid: targetUser.uid, username: targetUser.username });
      return;
    }
  }

  if (conversations.length > 0) {
    const first = conversations[0];
    openConversation(first.id, otherParticipant(first, currentUser.uid));
  }
}

function wireAuthLinks(scope) {
  scope.querySelectorAll("[data-auth-open]").forEach((el) => {
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

function renderLayout(conversations) {
  container.innerHTML = `
    <div class="messages-layout">
      <div class="conv-list-panel" id="conv-list-panel">
        <div class="conv-list-header">Conversations</div>
        <div id="conv-list">${conversationListHtml(conversations)}</div>
      </div>
      <div class="conv-thread-panel" id="conv-thread-panel">
        <div class="conv-no-selection">Select a conversation, or message someone from their profile.</div>
      </div>
    </div>
  `;

  wireConversationClicks();
}

function wireConversationClicks() {
  document.querySelectorAll("[data-conv-item]").forEach((el) => {
    el.addEventListener("click", () => {
      const conversationId = el.dataset.convItem;
      const otherUid = el.dataset.otherUid;
      const otherUsername = el.dataset.otherUsername;
      openConversation(conversationId, { uid: otherUid, username: otherUsername });
    });
  });
}

function conversationListHtml(conversations) {
  if (conversations.length === 0) {
    return `<div class="conv-empty">No conversations yet.</div>`;
  }
  return conversations
    .map((c) => {
      const other = otherParticipant(c, currentUser.uid);
      const isMine = c.lastMessageSenderUid === currentUser.uid;
      const preview = `${isMine ? "You: " : ""}${c.lastMessageText || ""}`;
      return `
      <div class="conv-item" data-conv-item="${escapeHtml(c.id)}" data-other-uid="${escapeHtml(other.uid)}" data-other-username="${escapeHtml(other.username)}">
        <div class="conv-pfp"></div>
        <div class="conv-info">
          <span class="conv-name">${escapeHtml(other.username)}</span>
          <span class="conv-preview">${escapeHtml(preview)}</span>
        </div>
      </div>
    `;
    })
    .join("");
}

async function openConversation(conversationId, other) {
  activeConversationId = conversationId;

  document.querySelectorAll("[data-conv-item]").forEach((el) => {
    el.classList.toggle("active", el.dataset.convItem === conversationId);
  });
  document.getElementById("conv-list-panel")?.classList.add("has-active");

  const threadPanel = document.getElementById("conv-thread-panel");
  threadPanel.innerHTML = `
    <div class="conv-thread-header">
      <a href="profile.html?user=${encodeURIComponent(other.username)}">${escapeHtml(other.username)}</a>
    </div>
    <div class="conv-messages" id="conv-messages">
      <div class="conv-empty">Loading…</div>
    </div>
    <div class="conv-compose">
      <input type="text" id="conv-input" placeholder="Type a message...">
      <button id="conv-send-btn">Send</button>
    </div>
  `;

  if (unsubscribeFromMessages) {
    unsubscribeFromMessages();
    unsubscribeFromMessages = null;
  }

  unsubscribeFromMessages = MessagingStore.subscribeToMessages(conversationId, (messages) => {
    renderMessages(messages);
  });

  const input = document.getElementById("conv-input");
  const sendBtn = document.getElementById("conv-send-btn");

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    input.disabled = true;

    const result = await MessagingStore.sendMessage(
      other.uid,
      other.username,
      currentUser.uid,
      currentUser.username,
      text
    );

    sendBtn.disabled = false;
    input.disabled = false;

    if (result.ok) {
      input.value = "";
      input.focus();
      refreshConversationList();
    } else {
      alert(result.error || "Could not send message.");
    }
  }

  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
  });
}

function renderMessages(messages) {
  const el = document.getElementById("conv-messages");
  if (!el) return;

  if (messages.length === 0) {
    el.innerHTML = `<div class="conv-empty">No messages yet — say hello.</div>`;
  } else {
    el.innerHTML = messages
      .map((m) => {
        const mine = m.senderUid === currentUser.uid;
        return `
        <div class="msg-bubble ${mine ? "mine" : "theirs"}">
          ${escapeHtml(m.text)}
          <span class="msg-time">${timeAgo(m.createdAtMs)}</span>
        </div>
      `;
      })
      .join("");
  }
  el.scrollTop = el.scrollHeight;
}

async function refreshConversationList() {
  const convResult = await MessagingStore.getConversationsForUser(currentUser.uid);
  const conversations = convResult.ok ? convResult.conversations : [];
  const listEl = document.getElementById("conv-list");
  if (listEl) {
    listEl.innerHTML = conversationListHtml(conversations);
    wireConversationClicks();
    document.querySelectorAll("[data-conv-item]").forEach((el) => {
      el.classList.toggle("active", el.dataset.convItem === activeConversationId);
    });
  }
}

init();
