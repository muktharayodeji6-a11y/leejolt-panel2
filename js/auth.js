// auth.js — Handles login, register, and session guarding for Leejolt Panel
import {
  auth,
  db,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updateProfile,
  doc,
  setDoc,
  getDoc,
  serverTimestamp
} from "./firebase.js";

// ---- Helpers ----
function showError(el, message) {
  if (!el) return;
  el.textContent = message;
  el.classList.add("visible");
}

function clearError(el) {
  if (!el) return;
  el.textContent = "";
  el.classList.remove("visible");
}

function setLoading(button, isLoading, loadingText = "Please wait...") {
  if (!button) return;
  if (isLoading) {
    button.dataset.originalText = button.textContent;
    button.textContent = loadingText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

// ---- Login ----
const loginForm = document.getElementById("loginForm");
if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const errorEl = document.getElementById("formError");
    const submitBtn = loginForm.querySelector("button[type='submit']");

    clearError(errorEl);
    setLoading(submitBtn, true, "Signing in...");

    try {
      await signInWithEmailAndPassword(auth, email, password);
      window.location.href = "dashboard.html";
    } catch (err) {
      setLoading(submitBtn, false);
      showError(errorEl, friendlyAuthError(err.code));
    }
  });
}

// ---- Register ----
const registerForm = document.getElementById("registerForm");
if (registerForm) {
  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("fullName").value.trim();
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const confirmPassword = document.getElementById("confirmPassword").value;
    const errorEl = document.getElementById("formError");
    const submitBtn = registerForm.querySelector("button[type='submit']");

    clearError(errorEl);

    if (password !== confirmPassword) {
      showError(errorEl, "Passwords do not match.");
      return;
    }
    if (password.length < 6) {
      showError(errorEl, "Password must be at least 6 characters.");
      return;
    }

    setLoading(submitBtn, true, "Creating account...");

    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: name });

      // Create user profile doc + wallet
      await setDoc(doc(db, "users", cred.user.uid), {
        fullName: name,
        email: email,
        role: "user",
        walletBalance: 0,
        createdAt: serverTimestamp()
      });

      window.location.href = "dashboard.html";
    } catch (err) {
      setLoading(submitBtn, false);
      showError(errorEl, friendlyAuthError(err.code));
    }
  });
}

// ---- Logout (used across pages) ----
const logoutButtons = document.querySelectorAll("[data-logout]");
logoutButtons.forEach((btn) => {
  btn.addEventListener("click", async () => {
    await signOut(auth);
    window.location.href = "index.html";
  });
});

// ---- Route guarding ----
// Pages that require login should include: <body data-require-auth>
// Pages that require admin should include: <body data-require-admin>
const body = document.body;
if (body.hasAttribute("data-require-auth") || body.hasAttribute("data-require-admin")) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = "index.html";
      return;
    }

    if (body.hasAttribute("data-require-admin")) {
      const snap = await getDoc(doc(db, "users", user.uid));
      const role = snap.exists() ? snap.data().role : "user";
      if (role !== "admin") {
        window.location.href = "dashboard.html";
        return;
      }
    }

    document.dispatchEvent(new CustomEvent("authReady", { detail: { user } }));
  });
}

// ---- Error message translation ----
function friendlyAuthError(code) {
  switch (code) {
    case "auth/invalid-email":
      return "That email address doesn't look right.";
    case "auth/user-disabled":
      return "This account has been disabled. Contact support.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Incorrect email or password.";
    case "auth/email-already-in-use":
      return "An account with this email already exists.";
    case "auth/weak-password":
      return "Password is too weak. Use at least 6 characters.";
    case "auth/network-request-failed":
      return "Network error. Check your connection and try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}
