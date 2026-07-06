// wallet.js — Wallet balance display and manual top-up request submission
import {
  db,
  auth,
  doc,
  getDoc,
  collection,
  addDoc,
  query,
  where,
  onSnapshot,
  serverTimestamp
} from "./firebase.js";

function formatNaira(amount) {
  return "₦" + Number(amount || 0).toLocaleString("en-NG", { minimumFractionDigits: 2 });
}

document.addEventListener("authReady", async (e) => {
  const user = e.detail.user;

  // Balance
  const userSnap = await getDoc(doc(db, "users", user.uid));
  const balanceEl = document.getElementById("walletBalance");
  if (userSnap.exists() && balanceEl) {
    balanceEl.textContent = formatNaira(userSnap.data().walletBalance);
  }

  // Top-up history
  const listEl = document.getElementById("topupsList");
  const q = query(collection(db, "topups"), where("userId", "==", user.uid));

  onSnapshot(q, (snapshot) => {
    const topups = snapshot.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

    if (!listEl) return;

    if (topups.length === 0) {
      listEl.innerHTML = "No top-up requests yet.";
      return;
    }

    listEl.innerHTML = topups
      .map(
        (t) => `
        <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--panel-border);">
          <span>${formatNaira(t.amount)} — ${t.reference || ""}</span>
          <span style="text-transform:capitalize; color: ${
            t.status === "confirmed" ? "var(--green)" : t.status === "rejected" ? "var(--red)" : "var(--gold)"
          };">${t.status || "pending"}</span>
        </div>`
      )
      .join("");
  });
});

// ---- Submit top-up request ----
const form = document.getElementById("topupForm");
if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const user = auth.currentUser;
    if (!user) return;

    const amount = parseFloat(document.getElementById("amount").value);
    const reference = document.getElementById("reference").value.trim();
    const errorEl = document.getElementById("topupError");
    const successEl = document.getElementById("topupSuccess");
    const submitBtn = form.querySelector("button[type='submit']");

    errorEl.classList.remove("visible");
    successEl.style.display = "none";

    if (!amount || amount < 100 || !reference) {
      errorEl.textContent = "Enter a valid amount and reference.";
      errorEl.classList.add("visible");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting...";

    try {
      // This creates a "pending" top-up request only.
      // Wallet balance is NOT credited here — an admin must confirm
      // the bank transfer manually from the admin panel before crediting.
      await addDoc(collection(db, "topups"), {
        userId: user.uid,
        amount,
        reference,
        status: "pending",
        createdAt: serverTimestamp()
      });

      successEl.textContent = "Submitted. Your wallet will be credited once confirmed by an admin.";
      successEl.style.display = "block";
      form.reset();
    } catch (err) {
      errorEl.textContent = "Something went wrong. Please try again.";
      errorEl.classList.add("visible");
      console.error(err);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit for confirmation";
    }
  });
}
