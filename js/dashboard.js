// dashboard.js — Populates the user dashboard with wallet + order data
import { db, doc, getDoc, collection, query, where, onSnapshot } from "./firebase.js";

function formatNaira(amount) {
  return "₦" + Number(amount || 0).toLocaleString("en-NG", { minimumFractionDigits: 2 });
}

document.addEventListener("authReady", async (e) => {
  const user = e.detail.user;

  // Greeting
  const nameSpan = document.getElementById("userNameSpan");
  if (nameSpan && user.displayName) {
    nameSpan.textContent = ", " + user.displayName.split(" ")[0];
  }

  // Wallet balance
  const userSnap = await getDoc(doc(db, "users", user.uid));
  const walletEl = document.getElementById("walletBalance");
  if (userSnap.exists() && walletEl) {
    walletEl.textContent = formatNaira(userSnap.data().walletBalance);
  }

  // Orders (live)
  const ordersRef = collection(db, "orders");
  const q = query(ordersRef, where("userId", "==", user.uid));

  onSnapshot(q, (snapshot) => {
    const orders = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

    document.getElementById("totalOrders").textContent = orders.length;
    document.getElementById("activeOrders").textContent =
      orders.filter((o) => ["pending", "processing", "in_progress"].includes(o.status)).length;
    document.getElementById("completedOrders").textContent =
      orders.filter((o) => o.status === "completed").length;

    const listEl = document.getElementById("recentOrdersList");
    if (!listEl) return;

    if (orders.length === 0) {
      listEl.innerHTML = 'No orders yet. <a href="orders.html">Place your first order</a>.';
      return;
    }

    const recent = orders
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
      .slice(0, 5);

    listEl.innerHTML = recent
      .map(
        (o) => `
        <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--panel-border);">
          <span>${o.service || "Service"} — ${o.link ? o.link.slice(0, 30) : ""}</span>
          <span style="color: var(--text-muted); text-transform: capitalize;">${o.status || "pending"}</span>
        </div>`
      )
      .join("");
  });
});
