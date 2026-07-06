// profile.js — Load and update profile info
import { db, updateProfile, doc, getDoc, updateDoc } from "./firebase.js";

document.addEventListener("authReady", async (e) => {
  const user = e.detail.user;

  document.getElementById("email").value = user.email || "";

  const snap = await getDoc(doc(db, "users", user.uid));
  if (snap.exists()) {
    document.getElementById("fullName").value = snap.data().fullName || "";
  }
});

const form = document.getElementById("profileForm");
if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { auth } = await import("./firebase.js");
    const user = auth.currentUser;
    if (!user) return;

    const fullName = document.getElementById("fullName").value.trim();
    const errorEl = document.getElementById("profileError");
    const successEl = document.getElementById("profileSuccess");
    const submitBtn = form.querySelector("button[type='submit']");

    errorEl.classList.remove("visible");
    successEl.style.display = "none";
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving...";

    try {
      await updateProfile(user, { displayName: fullName });
      await updateDoc(doc(db, "users", user.uid), { fullName });

      successEl.textContent = "Profile updated.";
      successEl.style.display = "block";
    } catch (err) {
      errorEl.textContent = "Could not save changes. Please try again.";
      errorEl.classList.add("visible");
      console.error(err);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save changes";
    }
  });
}
