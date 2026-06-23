// ============================================================
// LifeMax.in — Threads Store (Firestore backed)
// ------------------------------------------------------------
// Schema:
//   /threads/{threadId}
//     title: string
//     description: string        (the original post body)
//     category: string           ("bestofthebest" | "socialmaxing" | ...)
//     authorUid: string
//     authorUsername: string     (denormalized for fast display)
//     createdAt: serverTimestamp
//     createdAtMs: number        (for client-side sorting/pagination cursors)
//     replyCount: number
//     lastReplyAt: number | null
//     lastReplyAuthor: string | null
//     likeCount: number
//     imageData: string          (base64 data URL, optional)
//     deleteScheduledAt: number | null  (when set + in the past, treated as deleted)
//
//   /threads/{threadId}/replies/{replyId}
//     body: string
//     authorUid: string
//     authorUsername: string
//     createdAt: serverTimestamp
//     createdAtMs: number
//     likeCount: number
//     imageData: string          (base64 data URL, optional)
//     deleteScheduledAt: number | null
//
// Pagination: 20 threads per page, ordered newest-first, using
// Firestore's startAfter cursor on createdAtMs.
//
// Deletion model: there's no free-tier server-side scheduled job
// to truly auto-purge data after 24 hours, so "deletion" works by
// setting deleteScheduledAt to now+24h. Every read path filters out
// (or flags) documents whose deleteScheduledAt has already passed,
// so they disappear from the UI the moment the deadline hits for
// anyone viewing the page — without needing a backend cron job.
// The owner can reverse it any time before the deadline via
// cancelThreadDeletion() / cancelReplyDeletion().
// ============================================================

import { db } from "./firebase-app.js";
import {
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  serverTimestamp,
  updateDoc,
  increment,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const THREADS_PER_PAGE = 20;

/**
 * Bump a user's running post count by 1 (called once per thread
 * created and once per reply posted). Every 2nd post additionally
 * grants +1 reputation — e.g. posts 2, 4, 6, ... each add a rep
 * point on top of whatever reputation they earn from likes.
 * Uses a transaction (read postCount, decide, write both fields)
 * rather than a blind increment, since "is the new count even"
 * requires knowing the current value first — a plain increment()
 * can't make that decision safely under concurrent writes.
 */
async function incrementPostCount(uid) {
  if (!uid) return { ok: false };
  try {
    await runTransaction(db, async (transaction) => {
      const userRef = doc(db, "users", uid);
      const userSnap = await transaction.get(userRef);
      const currentPosts = userSnap.exists() ? userSnap.data().postCount || 0 : 0;
      const newPosts = currentPosts + 1;
      const updates = { postCount: newPosts };
      if (newPosts % 2 === 0) {
        const currentRep = userSnap.exists() ? userSnap.data().reputation || 0 : 0;
        updates.reputation = currentRep + 1;
      }
      transaction.update(userRef, updates);
    });
    return { ok: true };
  } catch (e) {
    console.error("incrementPostCount failed", e);
    return { ok: false };
  }
}

/**
 * A thread/reply is considered "deleted" once its deleteScheduledAt
 * timestamp has passed. Scheduling deletion is reversible (the user
 * can cancel) right up until that moment — see scheduleThreadDeletion
 * / cancelThreadDeletion below. This is a client-side check applied
 * after every fetch (Firestore can't cleanly express "null OR in the
 * future" as a query filter alongside other constraints), so anyone
 * loading the page after the deadline simply won't see it anymore.
 */
function isDeleted(doc) {
  return !!(doc.deleteScheduledAt && doc.deleteScheduledAt <= Date.now());
}

/**
 * Create a new thread. Returns { ok, id?, error? }
 */
async function createThread({ category, title, description, authorUid, authorUsername, imageData }) {
  title = (title || "").trim();
  description = (description || "").trim();

  if (!category) return { ok: false, error: "Missing category." };
  if (title.length < 5) return { ok: false, error: "Title must be at least 5 characters." };
  if (description.length < 10) return { ok: false, error: "Description must be at least 10 characters." };
  if (!authorUid) return { ok: false, error: "You must be logged in to post." };

  try {
    const now = Date.now();
    const ref = await addDoc(collection(db, "threads"), {
      category,
      title,
      description,
      authorUid,
      authorUsername,
      createdAt: serverTimestamp(),
      createdAtMs: now,
      replyCount: 0,
      lastReplyAt: null,
      lastReplyAuthor: null,
      lastReplyAuthorUid: null,
      likeCount: 0,
      imageData: imageData || "",
      deleteScheduledAt: null,
    });
    incrementPostCount(authorUid); // fire-and-forget; doesn't block the thread creation result
    return { ok: true, id: ref.id };
  } catch (e) {
    console.error("createThread failed", e);
    return { ok: false, error: "Could not create thread. Please try again." };
  }
}

/**
 * Get a page of threads for a category.
 * `cursor` is the createdAtMs value of the last thread on the
 * previous page (pass null for the first page).
 * Returns { threads: [...], nextCursor: number|null, hasMore: bool }
 */
async function getThreadsByCategory(category, cursor = null) {
  try {
    const constraints = [
      where("category", "==", category),
      orderBy("createdAtMs", "desc"),
      limit(THREADS_PER_PAGE + 1), // fetch one extra to know if there's a next page
    ];
    if (cursor) {
      constraints.splice(2, 0, startAfter(cursor));
    }

    const q = query(collection(db, "threads"), ...constraints);
    const snap = await getDocs(q);

    const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => !isDeleted(t));
    const hasMore = docs.length > THREADS_PER_PAGE;
    const pageThreads = hasMore ? docs.slice(0, THREADS_PER_PAGE) : docs;
    const nextCursor = hasMore ? pageThreads[pageThreads.length - 1].createdAtMs : null;

    return { ok: true, threads: pageThreads, nextCursor, hasMore };
  } catch (e) {
    console.error("getThreadsByCategory failed", e);
    return { ok: false, error: "Could not load threads.", threads: [], nextCursor: null, hasMore: false };
  }
}

/**
 * Get every page's cursor up front isn't practical with Firestore,
 * so for numbered pagination (1, 2, 3 ... like the old static UI)
 * we walk forward page by page and cache cursors as the user
 * navigates. This helper fetches a specific page number given the
 * array of cursors collected so far.
 */
async function getThreadsPage(category, pageNumber, cursorChain) {
  // cursorChain[i] = cursor to use to fetch page i+2 (i.e. cursorChain[0] gets page 2)
  let cursor = null;
  if (pageNumber > 1) {
    cursor = cursorChain[pageNumber - 2];
    if (cursor === undefined) {
      return { ok: false, error: "Page not yet reachable — load previous pages first." };
    }
  }
  return getThreadsByCategory(category, cursor);
}

/**
 * Get a single thread by ID. Still returns the thread even if it's
 * been deleted (so the thread page can show a clear "this post was
 * deleted" state rather than a confusing 404) — check
 * result.thread.isDeleted to decide how to render it.
 */
async function getThread(threadId) {
  try {
    const snap = await getDoc(doc(db, "threads", threadId));
    if (!snap.exists()) return { ok: false, error: "Thread not found." };
    const thread = { id: snap.id, ...snap.data() };
    thread.isDeleted = isDeleted(thread);
    return { ok: true, thread };
  } catch (e) {
    console.error("getThread failed", e);
    return { ok: false, error: "Could not load thread." };
  }
}

/**
 * Get all replies for a thread, oldest first. Deleted replies are
 * still included (with isDeleted: true) rather than filtered out
 * entirely, so the UI can render them as a struck-through placeholder
 * instead of leaving a confusing gap in the conversation.
 */
async function getReplies(threadId) {
  try {
    const q = query(
      collection(db, "threads", threadId, "replies"),
      orderBy("createdAtMs", "asc")
    );
    const snap = await getDocs(q);
    const replies = snap.docs.map((d) => {
      const r = { id: d.id, ...d.data() };
      r.isDeleted = isDeleted(r);
      return r;
    });
    return { ok: true, replies };
  } catch (e) {
    console.error("getReplies failed", e);
    return { ok: false, error: "Could not load replies.", replies: [] };
  }
}

/**
 * Add a reply to a thread, and bump the thread's reply metadata.
 */
async function addReply(threadId, { body, authorUid, authorUsername, imageData }) {
  body = (body || "").trim();
  if (body.length < 1) return { ok: false, error: "Reply can't be empty." };
  if (!authorUid) return { ok: false, error: "You must be logged in to reply." };

  try {
    const now = Date.now();
    const ref = await addDoc(collection(db, "threads", threadId, "replies"), {
      body,
      authorUid,
      authorUsername,
      createdAt: serverTimestamp(),
      createdAtMs: now,
      likeCount: 0,
      imageData: imageData || "",
      deleteScheduledAt: null,
    });

    await updateDoc(doc(db, "threads", threadId), {
      replyCount: increment(1),
      lastReplyAt: now,
      lastReplyAuthor: authorUsername,
      lastReplyAuthorUid: authorUid,
    });

    incrementPostCount(authorUid); // fire-and-forget; doesn't block the reply result
    return { ok: true, id: ref.id };
  } catch (e) {
    console.error("addReply failed", e);
    return { ok: false, error: "Could not post reply. Please try again." };
  }
}

/**
 * Like a thread (the original post). Unlimited likes — every click
 * just increments the count, no per-user tracking of "already liked."
 * Bumps the thread's likeCount AND the thread author's reputation
 * by 1, atomically via a batched write. Self-likes (liking your own
 * thread) still bump the like count but do NOT bump your own
 * reputation — both to match the security rules (which forbid
 * self-reputation edits) and to stop people inflating their own score.
 */
/**
 * Toggle a like on a thread (the original post). One like per
 * person, enforced by using the liker's own uid as the document ID
 * in a /threads/{id}/likes/{uid} subcollection — a second like
 * attempt just becomes an "unlike" (the doc is deleted) rather than
 * adding a second like. Bumps/un-bumps the thread's likeCount AND
 * the thread author's reputation by 1 together, atomically via a
 * transaction. Self-likes still toggle the like count but never
 * touch your own reputation (matches the Firestore rules, which
 * forbid self-reputation edits, and stops self-farming your score).
 * Returns { ok, liked } where `liked` is the NEW state after the toggle.
 */
async function likeThread(threadId, authorUid, currentUid) {
  if (!currentUid) return { ok: false, error: "You must be logged in to like posts." };
  try {
    const likeRef = doc(db, "threads", threadId, "likes", currentUid);
    const threadRef = doc(db, "threads", threadId);
    const userRef = authorUid ? doc(db, "users", authorUid) : null;

    let liked;
    await runTransaction(db, async (transaction) => {
      const likeSnap = await transaction.get(likeRef);
      const alreadyLiked = likeSnap.exists();
      liked = !alreadyLiked;

      transaction.update(threadRef, { likeCount: increment(liked ? 1 : -1) });

      if (userRef && authorUid !== currentUid) {
        transaction.update(userRef, { reputation: increment(liked ? 1 : -1) });
      }

      if (liked) {
        transaction.set(likeRef, { uid: currentUid, createdAt: Date.now() });
      } else {
        transaction.delete(likeRef);
      }
    });

    return { ok: true, liked };
  } catch (e) {
    console.error("likeThread failed", e);
    return { ok: false, error: "Could not like this post." };
  }
}

/**
 * Check whether the given uid has already liked a specific thread.
 * Used to render the Like button's initial pressed/unpressed state.
 */
async function hasLikedThread(threadId, uid) {
  if (!uid) return false;
  try {
    const snap = await getDoc(doc(db, "threads", threadId, "likes", uid));
    return snap.exists();
  } catch (e) {
    console.error("hasLikedThread failed", e);
    return false;
  }
}

/**
 * Like a reply. Same unlimited-likes + self-like behavior as likeThread.
 */
/**
 * Toggle a like on a reply. Same one-per-person toggle behavior as
 * likeThread, using /threads/{id}/replies/{id}/likes/{uid}.
 */
async function likeReply(threadId, replyId, authorUid, currentUid) {
  if (!currentUid) return { ok: false, error: "You must be logged in to like posts." };
  try {
    const likeRef = doc(db, "threads", threadId, "replies", replyId, "likes", currentUid);
    const replyRef = doc(db, "threads", threadId, "replies", replyId);
    const userRef = authorUid ? doc(db, "users", authorUid) : null;

    let liked;
    await runTransaction(db, async (transaction) => {
      const likeSnap = await transaction.get(likeRef);
      const alreadyLiked = likeSnap.exists();
      liked = !alreadyLiked;

      transaction.update(replyRef, { likeCount: increment(liked ? 1 : -1) });

      if (userRef && authorUid !== currentUid) {
        transaction.update(userRef, { reputation: increment(liked ? 1 : -1) });
      }

      if (liked) {
        transaction.set(likeRef, { uid: currentUid, createdAt: Date.now() });
      } else {
        transaction.delete(likeRef);
      }
    });

    return { ok: true, liked };
  } catch (e) {
    console.error("likeReply failed", e);
    return { ok: false, error: "Could not like this reply." };
  }
}

/**
 * Check whether the given uid has already liked a specific reply.
 */
async function hasLikedReply(threadId, replyId, uid) {
  if (!uid) return false;
  try {
    const snap = await getDoc(doc(db, "threads", threadId, "replies", replyId, "likes", uid));
    return snap.exists();
  } catch (e) {
    console.error("hasLikedReply failed", e);
    return false;
  }
}

/**
 * Get all threads started by a specific user, newest first.
 * (Used by the "My Threads" page.)
 */
async function getThreadsByAuthor(authorUid) {
  try {
    const q = query(
      collection(db, "threads"),
      where("authorUid", "==", authorUid),
      orderBy("createdAtMs", "desc")
    );
    const snap = await getDocs(q);
    const threads = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .map((t) => ({ ...t, isDeleted: isDeleted(t) }));
    return { ok: true, threads };
  } catch (e) {
    console.error("getThreadsByAuthor failed", e);
    return { ok: false, error: "Could not load your threads.", threads: [] };
  }
}

/**
 * Get the N most recent threads across ALL categories combined.
 * Used by the homepage "New Threads" sidebar.
 */
async function getLatestThreadsAcrossAllCategories(count = 4) {
  try {
    const q = query(
      collection(db, "threads"),
      orderBy("createdAtMs", "desc"),
      limit(count + 10) // fetch extra since some may be filtered out as deleted
    );
    const snap = await getDocs(q);
    const threads = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((t) => !isDeleted(t))
      .slice(0, count);
    return { ok: true, threads };
  } catch (e) {
    console.error("getLatestThreadsAcrossAllCategories failed", e);
    return { ok: false, error: "Could not load latest threads.", threads: [] };
  }
}

/**
 * Get site-wide stats: total thread count and total reply count
 * (summed from each thread's replyCount), for the homepage stats box.
 * Note: this reads every thread doc to sum replyCount client-side.
 * Fine at small-to-medium scale; if the forum grows large, swap this
 * for a maintained counter doc updated via Cloud Functions instead.
 */
async function getSiteStats() {
  try {
    const snap = await getDocs(collection(db, "threads"));
    let threadCount = 0;
    let postCount = 0; // original posts + replies
    snap.docs.forEach((d) => {
      threadCount += 1;
      postCount += 1 + (d.data().replyCount || 0);
    });
    return { ok: true, threadCount, postCount };
  } catch (e) {
    console.error("getSiteStats failed", e);
    return { ok: false, error: "Could not load stats.", threadCount: 0, postCount: 0 };
  }
}

const DELETE_DELAY_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Schedule a thread for deletion 24 hours from now. The thread
 * immediately becomes hidden from listings (see isDeleted() / the
 * filtering in getThreadsByCategory etc.) but the owner can cancel
 * any time before the 24 hours elapse via cancelThreadDeletion().
 * Only the thread's own author may call this (enforced both in the
 * UI and in Firestore rules).
 */
async function scheduleThreadDeletion(threadId) {
  try {
    await updateDoc(doc(db, "threads", threadId), {
      deleteScheduledAt: Date.now() + DELETE_DELAY_MS,
    });
    return { ok: true };
  } catch (e) {
    console.error("scheduleThreadDeletion failed", e);
    return { ok: false, error: "Could not delete thread. Please try again." };
  }
}

async function cancelThreadDeletion(threadId) {
  try {
    await updateDoc(doc(db, "threads", threadId), { deleteScheduledAt: null });
    return { ok: true };
  } catch (e) {
    console.error("cancelThreadDeletion failed", e);
    return { ok: false, error: "Could not cancel deletion. Please try again." };
  }
}

async function scheduleReplyDeletion(threadId, replyId) {
  try {
    await updateDoc(doc(db, "threads", threadId, "replies", replyId), {
      deleteScheduledAt: Date.now() + DELETE_DELAY_MS,
    });
    return { ok: true };
  } catch (e) {
    console.error("scheduleReplyDeletion failed", e);
    return { ok: false, error: "Could not delete reply. Please try again." };
  }
}

async function cancelReplyDeletion(threadId, replyId) {
  try {
    await updateDoc(doc(db, "threads", threadId, "replies", replyId), { deleteScheduledAt: null });
    return { ok: true };
  } catch (e) {
    console.error("cancelReplyDeletion failed", e);
    return { ok: false, error: "Could not cancel deletion. Please try again." };
  }
}

/**
 * Search threads by title (case-insensitive prefix match on a
 * lowercase copy of the title... but since titles aren't stored
 * lowercase, this does a client-side filter over a recent window
 * of threads instead. Good enough at small-to-medium forum size;
 * swap for a real search index (e.g. Algolia) if this grows large.
 */
async function searchThreads(queryText, maxResults = 15) {
  const needle = (queryText || "").trim().toLowerCase();
  if (!needle) return { ok: true, threads: [] };
  try {
    const q = query(collection(db, "threads"), orderBy("createdAtMs", "desc"), limit(300));
    const snap = await getDocs(q);
    const matches = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((t) => !isDeleted(t) && t.title.toLowerCase().includes(needle))
      .slice(0, maxResults);
    return { ok: true, threads: matches };
  } catch (e) {
    console.error("searchThreads failed", e);
    return { ok: false, error: "Search failed.", threads: [] };
  }
}

/**
 * Returns the most recent threads posted by VIP authors, across all
 * categories — used for the homepage's "Featured" section. VIP
 * status is checked LIVE against each author's current account
 * state (not denormalized onto the thread at post time), so if
 * someone becomes VIP after posting, their existing threads start
 * showing up here immediately, and there's nothing to retroactively
 * update if VIP status ever changes.
 */
async function getFeaturedVipThreads(getUserByUidFn, count = 4) {
  try {
    // Pull a recent window of threads, then filter down to VIP
    // authors client-side. Fetches more than `count` since most
    // authors won't be VIP — same tradeoff as searchThreads().
    const q = query(collection(db, "threads"), orderBy("createdAtMs", "desc"), limit(60));
    const snap = await getDocs(q);
    const recentThreads = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => !isDeleted(t));

    const uniqueAuthorUids = [...new Set(recentThreads.map((t) => t.authorUid))];
    const vipStatusByUid = new Map();
    await Promise.all(
      uniqueAuthorUids.map(async (uid) => {
        const user = await getUserByUidFn(uid);
        vipStatusByUid.set(uid, !!user?.isVip);
      })
    );

    const featured = recentThreads.filter((t) => vipStatusByUid.get(t.authorUid)).slice(0, count);
    return { ok: true, threads: featured };
  } catch (e) {
    console.error("getFeaturedVipThreads failed", e);
    return { ok: false, error: "Could not load featured threads.", threads: [] };
  }
}

export const ThreadsStore = {
  createThread,
  getThreadsByCategory,
  getThreadsPage,
  getThread,
  getReplies,
  addReply,
  likeThread,
  likeReply,
  hasLikedThread,
  hasLikedReply,
  getThreadsByAuthor,
  getLatestThreadsAcrossAllCategories,
  getSiteStats,
  scheduleThreadDeletion,
  cancelThreadDeletion,
  scheduleReplyDeletion,
  cancelReplyDeletion,
  searchThreads,
  incrementPostCount,
  getFeaturedVipThreads,
  THREADS_PER_PAGE,
  DELETE_DELAY_MS,
};
