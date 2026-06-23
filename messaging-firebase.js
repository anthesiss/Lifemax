// ============================================================
// LifeMax.in — Messaging Store (Firestore backed)
// ------------------------------------------------------------
// Schema:
//   /conversations/{conversationId}
//     participants: [uidA, uidB]                 (sorted, smaller uid first)
//     participantUsernames: { [uid]: username }   (denormalized for display)
//     lastMessageAt: number
//     lastMessageText: string
//     lastMessageSenderUid: string
//     createdAt: serverTimestamp
//
//   /conversations/{conversationId}/messages/{messageId}
//     senderUid: string
//     text: string
//     createdAt: serverTimestamp
//     createdAtMs: number
//
// Conversation IDs are deterministic: both participant uids sorted
// alphabetically and joined with an underscore. This means "start a
// conversation with X" is just "does this exact doc ID already
// exist" — no search needed, and there's only ever ONE conversation
// between any two given people.
// ============================================================

import { db } from "./firebase-app.js";
import {
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  setDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  updateDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

function conversationIdFor(uidA, uidB) {
  return [uidA, uidB].sort().join("_");
}

/**
 * Get (or implicitly prepare to create) the conversation between
 * the current user and another user. Returns the conversation doc
 * if it already exists, or null if no messages have been sent yet
 * (the doc is only actually created on the first sendMessage call).
 */
async function getConversation(uidA, uidB) {
  const conversationId = conversationIdFor(uidA, uidB);
  try {
    const snap = await getDoc(doc(db, "conversations", conversationId));
    if (!snap.exists()) return { ok: true, conversation: null, conversationId };
    return { ok: true, conversation: { id: snap.id, ...snap.data() }, conversationId };
  } catch (e) {
    console.error("getConversation failed", e);
    return { ok: false, error: "Could not load conversation.", conversationId };
  }
}

/**
 * Send a message, creating the conversation doc on the first send
 * if it doesn't exist yet.
 */
async function sendMessage(otherUid, otherUsername, senderUid, senderUsername, text) {
  text = (text || "").trim();
  if (!text) return { ok: false, error: "Message can't be empty." };
  if (!senderUid || !otherUid) return { ok: false, error: "Missing participant." };

  const conversationId = conversationIdFor(senderUid, otherUid);
  const now = Date.now();

  try {
    const convRef = doc(db, "conversations", conversationId);
    const convSnap = await getDoc(convRef);

    if (!convSnap.exists()) {
      await setDoc(convRef, {
        participants: [senderUid, otherUid].sort(),
        participantUsernames: {
          [senderUid]: senderUsername,
          [otherUid]: otherUsername,
        },
        createdAt: serverTimestamp(),
        lastMessageAt: now,
        lastMessageText: text,
        lastMessageSenderUid: senderUid,
      });
    } else {
      await updateDoc(convRef, {
        lastMessageAt: now,
        lastMessageText: text,
        lastMessageSenderUid: senderUid,
      });
    }

    await addDoc(collection(db, "conversations", conversationId, "messages"), {
      senderUid,
      text,
      createdAt: serverTimestamp(),
      createdAtMs: now,
    });

    return { ok: true, conversationId };
  } catch (e) {
    console.error("sendMessage failed", e);
    return { ok: false, error: "Could not send message. Please try again." };
  }
}

/**
 * Get every conversation the current user is part of, newest
 * activity first. Used for the inbox list on the left side of the
 * Messages page.
 */
async function getConversationsForUser(uid) {
  if (!uid) return { ok: false, error: "Not logged in.", conversations: [] };
  try {
    // Note: deliberately NOT combining orderBy with array-contains here —
    // that pairing requires a manually-created composite index in
    // Firestore, and until that index exists the query is rejected
    // (sometimes surfaced as a confusing "permission-denied" error
    // rather than a clear "missing index" one). Sorting client-side
    // avoids needing that index at all.
    const q = query(collection(db, "conversations"), where("participants", "array-contains", uid));
    const snap = await getDocs(q);
    const conversations = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
    return { ok: true, conversations };
  } catch (e) {
    console.error("getConversationsForUser failed", e);
    return { ok: false, error: "Could not load conversations.", conversations: [] };
  }
}

/**
 * Get all messages in a conversation, oldest first.
 */
async function getMessages(conversationId) {
  try {
    const q = query(
      collection(db, "conversations", conversationId, "messages"),
      orderBy("createdAtMs", "asc")
    );
    const snap = await getDocs(q);
    const messages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return { ok: true, messages };
  } catch (e) {
    console.error("getMessages failed", e);
    return { ok: false, error: "Could not load messages.", messages: [] };
  }
}

/**
 * Subscribe to live updates for a conversation's messages. Calls
 * `callback` with the full up-to-date message list every time
 * something changes. Returns an unsubscribe function — call it
 * when leaving the page/switching conversations to stop listening.
 */
function subscribeToMessages(conversationId, callback) {
  const q = query(
    collection(db, "conversations", conversationId, "messages"),
    orderBy("createdAtMs", "asc")
  );
  return onSnapshot(q, (snap) => {
    const messages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    callback(messages);
  });
}

export const MessagingStore = {
  conversationIdFor,
  getConversation,
  sendMessage,
  getConversationsForUser,
  getMessages,
  subscribeToMessages,
};
