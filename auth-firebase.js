// ============================================================
// LifeMax.in — Auth Store (Firebase Auth + Firestore backed)
// ------------------------------------------------------------
// Method shapes:
//   signUp(username, password)        -> { ok, error?, user? }
//   logIn(username, password)         -> { ok, error?, queued?, secondsLeft?, user? }
//   signInWithGoogle()                -> { ok, error?, isNewAccount?, user? }
//   logOut()                          -> { ok }
//   getCurrentUser()                  -> user doc or null
//   getQueueStatus()                  -> { loggedIn, ready, msLeft, user }
//   getUserByUid(uid)                 -> public profile or null
//   getUserByUsername(username)       -> public profile or null (excludes deactivated)
//   updateProfile(uid, {bio, pfpUrl}) -> { ok, error? }
//   updateRankColor(uid, color)       -> { ok, error? }
//   deactivateAccount(uid)            -> { ok, error? }
//   searchUsers(text)                 -> { ok, users[] }
//
// Firebase Auth needs an email, so usernames are mapped to a
// synthetic email under a fixed fake domain
// (username@users.statusmax.local) purely so people can sign up
// with just a username + password.
//
// Each user gets a Firestore doc at /users/{uid} holding:
//   { username, usernameLower, createdAt, createdAtMs, readyAtMs,
//     bio, pfpUrl, reputation, rankColor, deactivated }
// readyAt is "now + 1 minute" at signup time, and is what the
// 1-minute queue gate checks against.
// ============================================================

import { auth, db } from "./firebase-app.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  setDoc,
  getDoc,
  serverTimestamp,
  Timestamp,
  query,
  collection,
  where,
  getDocs,
  getCountFromServer,
  limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const QUEUE_WAIT_MS = 60 * 1000; // 1 minute before account is usable
const FAKE_EMAIL_DOMAIN = "users.statusmax.local";

function usernameToEmail(username) {
  return `${username.trim().toLowerCase()}@${FAKE_EMAIL_DOMAIN}`;
}

function friendlyAuthError(code) {
  switch (code) {
    case "auth/email-already-in-use":
      return "That username is already taken.";
    case "auth/weak-password":
      return "Password must be at least 6 characters.";
    case "auth/invalid-email":
      return "That username isn't valid.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Incorrect username or password.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a moment and try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

async function signUp(username, password) {
  username = (username || "").trim();
  password = password || "";

  if (username.length < 3) {
    return { ok: false, error: "Username must be at least 3 characters." };
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return { ok: false, error: "Usernames can only contain letters, numbers, and underscores." };
  }
  if (password.length < 6) {
    return { ok: false, error: "Password must be at least 6 characters." };
  }

  const email = usernameToEmail(username);

  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const now = Date.now();
    const readyAt = now + QUEUE_WAIT_MS;

    await setDoc(doc(db, "users", cred.user.uid), {
      username,
      usernameLower: username.toLowerCase(),
      createdAt: serverTimestamp(),
      createdAtMs: now,
      readyAtMs: readyAt, // plain number for easy client-side comparison
      bio: "",
      pfpUrl: "",
      reputation: 0,
      postCount: 0,
      rankColor: "gold",
      deactivated: false,
      isVip: false,
    });

    return {
      ok: true,
      user: { uid: cred.user.uid, username, readyAt },
    };
  } catch (e) {
    return { ok: false, error: friendlyAuthError(e.code) };
  }
}

async function logIn(username, password) {
  username = (username || "").trim();
  const email = usernameToEmail(username);

  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const userDoc = await getDoc(doc(db, "users", cred.user.uid));

    if (!userDoc.exists()) {
      return { ok: false, error: "Account data not found. Please contact support." };
    }

    const data = userDoc.data();
    const readyAt = data.readyAtMs || 0;

    if (Date.now() < readyAt) {
      const secondsLeft = Math.ceil((readyAt - Date.now()) / 1000);
      // Note: we don't sign them out — they ARE logged in, just gated
      // from posting until the queue finishes. This matches the old
      // behavior where signup logged you in immediately.
      return {
        ok: false,
        queued: true,
        error: `Your account is still in the queue. Try again in ${secondsLeft}s.`,
        secondsLeft,
      };
    }

    return {
      ok: true,
      user: { uid: cred.user.uid, username: data.username, readyAt },
    };
  } catch (e) {
    return { ok: false, error: friendlyAuthError(e.code) };
  }
}

async function logOut() {
  await signOut(auth);
  return { ok: true };
}

/**
 * Sign in with Google via a popup. On a brand new Google account,
 * creates a matching /users/{uid} doc (same shape as a normal
 * signup, including the 1-minute posting queue) using their Google
 * display name as the username — with a numeric suffix appended if
 * that username is already taken by someone else. On a returning
 * Google account, just logs them in as usual (no queue, since
 * their account already exists and already passed it once).
 */
async function signInWithGoogle() {
  try {
    const provider = new GoogleAuthProvider();
    const cred = await signInWithPopup(auth, provider);
    const uid = cred.user.uid;

    const existingDoc = await getDoc(doc(db, "users", uid));
    if (existingDoc.exists()) {
      const data = existingDoc.data();
      const readyAt = data.readyAtMs || 0;
      return {
        ok: true,
        isNewAccount: false,
        user: { uid, username: data.username, readyAt },
      };
    }

    // First time this Google account has signed in — create their
    // StatusMax profile, deriving a username from their Google name.
    let baseUsername = (cred.user.displayName || "user")
      .replace(/[^a-zA-Z0-9_]/g, "")
      .slice(0, 20);
    if (baseUsername.length < 3) baseUsername = "user" + Math.floor(Math.random() * 10000);

    let candidate = baseUsername;
    let suffix = 0;
    // Keep trying until we find a username that isn't taken.
    while (true) {
      const check = await getUserByUsername(candidate);
      if (!check) break;
      suffix += 1;
      candidate = `${baseUsername}${suffix}`;
    }

    const now = Date.now();
    const readyAt = now + QUEUE_WAIT_MS;

    await setDoc(doc(db, "users", uid), {
      username: candidate,
      usernameLower: candidate.toLowerCase(),
      createdAt: serverTimestamp(),
      createdAtMs: now,
      readyAtMs: readyAt,
      bio: "",
      pfpUrl: cred.user.photoURL || "",
      reputation: 0,
      postCount: 0,
      rankColor: "gold",
      deactivated: false,
      isVip: false,
      signedUpViaGoogle: true,
    });

    return {
      ok: true,
      isNewAccount: true,
      user: { uid, username: candidate, readyAt },
    };
  } catch (e) {
    if (e.code === "auth/popup-closed-by-user") {
      return { ok: false, error: "Sign-in was cancelled." };
    }
    if (e.code === "auth/popup-blocked") {
      return { ok: false, error: "Your browser blocked the sign-in popup. Please allow popups and try again." };
    }
    console.error("signInWithGoogle failed", e);
    return { ok: false, error: "Could not sign in with Google. Please try again." };
  }
}

/**
 * Returns the currently logged-in user's Firestore record (or null).
 * On the very first call, waits for Firebase Auth's initial state
 * check to resolve (since auth.currentUser is null for a brief
 * moment on page load even if a session exists). After that initial
 * check has happened once, we trust auth.currentUser directly —
 * it updates synchronously and immediately after signOut()/signIn(),
 * unlike the one-time readiness promise (which must never be used
 * as a long-term cache, or logout/login would appear to need a
 * page refresh to take effect).
 */
let _authReadyPromise = null;
let _authHasInitialized = false;
function _waitForAuthReady() {
  if (_authHasInitialized) return Promise.resolve(auth.currentUser);
  if (_authReadyPromise) return _authReadyPromise;
  _authReadyPromise = new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (firebaseUser) => {
      _authHasInitialized = true;
      unsub();
      resolve(firebaseUser);
    });
  });
  return _authReadyPromise;
}

async function getCurrentUser() {
  const firebaseUser = _authHasInitialized ? auth.currentUser : await _waitForAuthReady();
  if (!firebaseUser) return null;

  const userDoc = await getDoc(doc(db, "users", firebaseUser.uid));
  if (!userDoc.exists()) return null;

  const data = userDoc.data();
  return {
    uid: firebaseUser.uid,
    username: data.username,
    readyAt: data.readyAtMs || 0,
    createdAtMs: data.createdAtMs || null,
    bio: data.bio || "",
    pfpUrl: data.pfpUrl || "",
    reputation: data.reputation || 0,
    postCount: data.postCount || 0,
    rankColor: data.rankColor || "gold",
    deactivated: !!data.deactivated,
    isVip: !!data.isVip,
  };
}

/**
 * Returns queue status for the current session:
 * { loggedIn: bool, ready: bool, msLeft: number, user }
 */
async function getQueueStatus() {
  const user = await getCurrentUser();
  if (!user) {
    return { loggedIn: false, ready: false, msLeft: 0, user: null };
  }
  const msLeft = Math.max(0, user.readyAt - Date.now());
  return { loggedIn: true, ready: msLeft <= 0, msLeft, user };
}

/**
 * Look up a username's basic public info (for display purposes,
 * e.g. showing thread authors without exposing emails/uids broadly).
 */
async function getUserByUid(uid) {
  if (!uid) return null;
  const userDoc = await getDoc(doc(db, "users", uid));
  if (!userDoc.exists()) return null;
  const data = userDoc.data();
  return {
    uid,
    username: data.username,
    bio: data.bio || "",
    pfpUrl: data.pfpUrl || "",
    reputation: data.reputation || 0,
    postCount: data.postCount || 0,
    createdAtMs: data.createdAtMs || null,
    rankColor: data.rankColor || "gold",
    deactivated: !!data.deactivated,
    isVip: !!data.isVip,
  };
}

/**
 * Look up a user by their username (case-insensitive), for profile
 * pages reached via ?user=username in the URL.
 */
async function getUserByUsername(username) {
  if (!username) return null;
  const usernameLower = username.trim().toLowerCase();
  try {
    const q = query(collection(db, "users"), where("usernameLower", "==", usernameLower));
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const docSnap = snap.docs[0];
    const data = docSnap.data();
    if (data.deactivated) return null; // deactivated accounts are not lookupable
    return {
      uid: docSnap.id,
      username: data.username,
      bio: data.bio || "",
      pfpUrl: data.pfpUrl || "",
      reputation: data.reputation || 0,
      postCount: data.postCount || 0,
      createdAtMs: data.createdAtMs || null,
      rankColor: data.rankColor || "gold",
      isVip: !!data.isVip,
    };
  } catch (e) {
    console.error("getUserByUsername failed", e);
    return null;
  }
}

/**
 * Update the current user's editable profile fields (bio, pfpUrl).
 * Username/reputation/dates are not editable here.
 */
async function updateProfile(uid, { bio, pfpUrl }) {
  if (!uid) return { ok: false, error: "Not logged in." };
  const updates = {};
  if (typeof bio === "string") {
    if (bio.length > 50) return { ok: false, error: "Bio must be 50 characters or fewer." };
    updates.bio = bio;
  }
  if (typeof pfpUrl === "string") {
    const isHttpUrl = /^https?:\/\//i.test(pfpUrl);
    const isDataUrl = /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(pfpUrl);
    if (pfpUrl.length > 0 && !isHttpUrl && !isDataUrl) {
      return { ok: false, error: "Profile picture must be an uploaded image." };
    }
    if (pfpUrl.length > 900000) {
      return { ok: false, error: "That image is too large. Try a smaller picture." };
    }
    updates.pfpUrl = pfpUrl;
  }
  try {
    await setDoc(doc(db, "users", uid), updates, { merge: true });
    return { ok: true };
  } catch (e) {
    console.error("updateProfile failed", e);
    return { ok: false, error: "Could not update profile. Please try again." };
  }
}

/**
 * Update the current user's chosen rank glow/particle color.
 * Only meaningful once they've crossed 100 reputation, but there's
 * no harm letting them pre-pick it earlier.
 */
async function updateRankColor(uid, rankColor) {
  if (!uid) return { ok: false, error: "Not logged in." };
  const validColors = ["gold", "blue", "crimson", "emerald", "violet"];
  if (!validColors.includes(rankColor)) {
    return { ok: false, error: "Not a valid color choice." };
  }
  try {
    await setDoc(doc(db, "users", uid), { rankColor }, { merge: true });
    return { ok: true };
  } catch (e) {
    console.error("updateRankColor failed", e);
    return { ok: false, error: "Could not update color. Please try again." };
  }
}

/**
 * Deactivate the current user's account. Their existing threads and
 * replies are left untouched in the database (per design — content
 * stays, attribution stays as the username string already stored on
 * each post), but:
 *   - their /users/{uid} doc is marked deactivated: true
 *   - getUserByUsername() will no longer find them (profile becomes
 *     unlookupable)
 *   - the Firebase Auth login itself is left intact (not a hard
 *     delete), per the chosen design — this just hides the profile
 * Username display on old posts will still show their old username,
 * since that's denormalized onto each thread/reply at post time.
 */
async function deactivateAccount(uid) {
  if (!uid) return { ok: false, error: "Not logged in." };
  try {
    await setDoc(
      doc(db, "users", uid),
      { deactivated: true, deactivatedAt: Date.now() },
      { merge: true }
    );
    await signOut(auth);
    return { ok: true };
  } catch (e) {
    console.error("deactivateAccount failed", e);
    return { ok: false, error: "Could not deactivate account. Please try again." };
  }
}

/**
 * Search for users whose username starts with the given query
 * (case-insensitive prefix match), excluding deactivated accounts.
 * Used by the site-wide search when the person has selected "Users".
 */
async function searchUsers(queryText, maxResults = 15) {
  const prefix = (queryText || "").trim().toLowerCase();
  if (!prefix) return { ok: true, users: [] };
  try {
    // Firestore range trick for prefix matching: usernameLower in
    // [prefix, prefix + '\uf8ff') catches every string starting with prefix.
    const q = query(
      collection(db, "users"),
      where("usernameLower", ">=", prefix),
      where("usernameLower", "<=", prefix + "\uf8ff"),
      limit(maxResults)
    );
    const snap = await getDocs(q);
    const users = snap.docs
      .map((d) => ({ uid: d.id, ...d.data() }))
      .filter((u) => !u.deactivated)
      .map((u) => ({
        uid: u.uid,
        username: u.username,
        pfpUrl: u.pfpUrl || "",
        reputation: u.reputation || 0,
        rankColor: u.rankColor || "gold",
      }));
    return { ok: true, users };
  } catch (e) {
    console.error("searchUsers failed", e);
    return { ok: false, error: "Search failed.", users: [] };
  }
}

/**
 * Returns the total number of registered accounts (including
 * deactivated ones — deactivation hides a profile, it doesn't
 * delete the account). Uses Firestore's count() aggregation so this
 * is one cheap query rather than downloading every user document.
 */
async function getUserCount() {
  try {
    const snap = await getCountFromServer(collection(db, "users"));
    return { ok: true, count: snap.data().count };
  } catch (e) {
    console.error("getUserCount failed", e);
    return { ok: false, count: 0 };
  }
}

/**
 * Grant VIP status to the current user's own account. Called from
 * the Stripe success-redirect landing page — reaching that specific
 * URL is only possible by completing checkout via the Payment Link,
 * which is the (lightweight, non-cryptographic) verification this
 * site uses for now. See vip-success.html / vip-success-page.js.
 */
async function grantVip(uid) {
  if (!uid) return { ok: false, error: "Not logged in." };
  try {
    await setDoc(
      doc(db, "users", uid),
      { isVip: true, vipGrantedAt: Date.now() },
      { merge: true }
    );
    return { ok: true };
  } catch (e) {
    console.error("grantVip failed", e);
    return { ok: false, error: "Could not activate VIP. Please try again." };
  }
}

export const AuthStore = {
  signUp,
  logIn,
  logOut,
  signInWithGoogle,
  getCurrentUser,
  getQueueStatus,
  getUserByUid,
  getUserByUsername,
  updateProfile,
  updateRankColor,
  deactivateAccount,
  searchUsers,
  getUserCount,
  grantVip,
  QUEUE_WAIT_MS,
};
