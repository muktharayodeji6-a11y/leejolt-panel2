// orders.js — Handles order submission and order history display
import {
  db,
  auth,
  functions,
  httpsCallable,
  doc,
  getDoc,
  updateDoc,
  collection,
  addDoc,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  increment
} from "./firebase.js";

// Calls the "createOrder" Cloud Function, which holds the real
// Betalogs API key server-side (via Firebase Secrets) and forwards the order.
const createOrderFn = httpsCallable(functions, "createOrder");

const SERVICE_PRICES = {
  instagram_followers: 5,   // ₦ per unit
  instagram_likes: 2,
  instagram_views: 1,
  tiktok_followers: 4,
  tiktok_likes: 2,
  tiktok_views: 1
};

function formatNaira(amount) {
  return "₦" + Number(amount || 0).toLocaleString("en-NG", { minimumFractionDigits: 2 });
}

const form = document.getElementById("newOrderForm");
if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const user = auth.currentUser;
    if (!user) return;

    const service = document.getElementById("service").value;
    const link = document.getElementById("link").value.trim();
    const quantity = parseInt(document.getElementById("quantity").value, 10);
    const errorEl = document.getElementById("orderError");
    const successEl = document.getElementById("orderSuccess");
    const submitBtn = form.querySelector("button[type='submit']");

    errorEl.classList.remove("visible");
    successEl.style.display = "none";

    if (!service || !link || !quantity || quantity < 100) {
      errorEl.textContent = "Fill all fields. Minimum quantity is 100.";
      errorEl.classList.add("visible");
      return;
    }

    const pricePerUnit = SERVICE_PRICES[service] || 0;
    const totalCost = pricePerUnit * quantity;

    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting...";

    try {
      // Check wallet balance
      const userRef = doc(db, "users", user.uid);
      const userSnap = await getDoc(userRef);
      const balance = userSnap.exists() ? userSnap.data().walletBalance || 0 : 0;

      if (balance < totalCost) {
        errorEl.textContent = `Insufficient balance. This order costs ${formatNaira(totalCost)}, your wallet has ${formatNaira(balance)}. Please fund your wallet.`;
        errorEl.classList.add("visible");
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit order";
        return;
      }

      // Deduct wallet balance
      await updateDoc(userRef, { walletBalance: increment(-totalCost) });

      // Create order record in Firestore
      const orderDoc = await addDoc(collection(db, "orders"), {
        userId: user.uid,
        service,
        link,
        quantity,
        cost: totalCost,
        status: "pending",
        createdAt: serverTimestamp()
      });

      // Notify the Cloud Function to place the order with Betalogs.
      // If this fails, the order stays "pending" and an admin can retry manually.
      try {
        await createOrderFn({
          orderId: orderDoc.id,
          service,
          link,
          quantity
        });
      } catch (apiErr) {
        console.warn("Order saved but Cloud Function call failed, will need manual review:", apiErr);
      }

      successEl.textContent = "Order submitted successfully.";
      successEl.style.display = "block";
      form.reset();
    } catch (err) {
      errorEl.textContent = "Something went wrong. Please try again.";
      errorEl.classList.add("visible");
      console.error(err);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit order";
    }
  });
}

// ---- Order history ----
document.addEventListener("authReady", (e) => {
  const user = e.detail.user;
  const tableEl = document.getElementById("ordersTable");
  if (!tableEl) return;

  const q = query(collection(db, "orders"), where("userId", "==", user.uid));

  onSnapshot(q, (snapshot) => {
    const orders = snapshot.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

    if (orders.length === 0) {
      tableEl.innerHTML = "No orders yet.";
      return;
    }

    tableEl.innerHTML = orders
      .map(
        (o) => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px solid var(--panel-border); gap: 12px; flex-wrap: wrap;">
          <div>
            <div style="color: var(--text); font-weight: 500;">${(o.service || "").replace(/_/g, " ")}</div>
            <div style="font-size: 12px;">${o.quantity} units — ${formatNaira(o.cost)}</div>
          </div>
          <span style="text-transform: capitalize; color: ${o.status === "completed" ? "var(--green)" : "var(--gold)"};">${o.status || "pending"}</span>
        </div>`
      )
      .join("");
  });
});
