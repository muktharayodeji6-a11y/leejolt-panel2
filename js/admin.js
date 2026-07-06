// admin.js — Admin dashboard, users, orders, and settings logic
import {
  db,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  onSnapshot,
  increment
} from "./firebase.js";

function formatNaira(amount) {
  return "₦" + Number(amount || 0).toLocaleString("en-NG", { minimumFractionDigits: 2 });
}

function badge(status) {
  return `<span class="badge badge-${status || "pending"}">${status || "pending"}</span>`;
}

document.addEventListener("authReady", () => {
  wireOverview();
  wireUsers();
  wireOrders();
  wireSettings();
});

// ---- Overview ----
function wireOverview() {
  const totalUsersEl = document.getElementById("totalUsers");
  const totalOrdersEl = document.getElementById("totalOrders");
  const pendingOrdersEl = document.getElementById("pendingOrders");
  const pendingTopupsEl = document.getElementById("pendingTopups");
  const pendingTopupsListEl = document.getElementById("pendingTopupsList");

  if (totalUsersEl) {
    onSnapshot(collection(db, "users"), (snap) => {
      totalUsersEl.textContent = snap.size;
    });
  }

  if (totalOrdersEl) {
    onSnapshot(collection(db, "orders"), (snap) => {
      totalOrdersEl.textContent = snap.size;
      pendingOrdersEl.textContent = snap.docs.filter((d) => d.data().status === "pending").length;
    });
  }

  if (pendingTopupsListEl) {
    const q = query(collection(db, "topups"), where("status", "==", "pending"));
    onSnapshot(q, (snap) => {
      pendingTopupsEl.textContent = snap.size;

      if (snap.empty) {
        pendingTopupsListEl.innerHTML = "No pending top-ups.";
        return;
      }

      pendingTopupsListEl.innerHTML = snap.docs
        .map((d) => {
          const t = d.data();
          return `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid var(--panel-border);">
            <span>${formatNaira(t.amount)} — ${t.reference || ""}</span>
            <span>
              <button class="btn-small approve" data-approve-topup="${d.id}" data-uid="${t.userId}" data-amount="${t.amount}">Approve</button>
              <button class="btn-small reject" data-reject-topup="${d.id}">Reject</button>
            </span>
          </div>`;
        })
        .join("");

      pendingTopupsListEl.querySelectorAll("[data-approve-topup]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const topupId = btn.dataset.approveTopup;
          const uid = btn.dataset.uid;
          const amount = parseFloat(btn.dataset.amount);
          btn.disabled = true;
          try {
            await updateDoc(doc(db, "users", uid), { walletBalance: increment(amount) });
            await updateDoc(doc(db, "topups", topupId), { status: "confirmed" });
          } catch (err) {
            console.error(err);
            btn.disabled = false;
          }
        });
      });

      pendingTopupsListEl.querySelectorAll("[data-reject-topup]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const topupId = btn.dataset.rejectTopup;
          btn.disabled = true;
          try {
            await updateDoc(doc(db, "topups", topupId), { status: "rejected" });
          } catch (err) {
            console.error(err);
            btn.disabled = false;
          }
        });
      });
    });
  }
}

// ---- Users ----
function wireUsers() {
  const tbody = document.getElementById("usersTableBody");
  if (!tbody) return;

  onSnapshot(collection(db, "users"), (snap) => {
    if (snap.empty) {
      tbody.innerHTML = '<tr><td colspan="5">No users yet.</td></tr>';
      return;
    }

    tbody.innerHTML = snap.docs
      .map((d) => {
        const u = d.data();
        const joined = u.createdAt?.seconds
          ? new Date(u.createdAt.seconds * 1000).toLocaleDateString()
          : "—";
        return `
        <tr>
          <td>${u.fullName || "—"}</td>
          <td>${u.email || "—"}</td>
          <td>${formatNaira(u.walletBalance)}</td>
          <td style="text-transform:capitalize;">${u.role || "user"}</td>
          <td>${joined}</td>
        </tr>`;
      })
      .join("");
  });
}

// ---- Orders ----
function wireOrders() {
  const tbody = document.getElementById("ordersTableBody");
  if (!tbody) return;

  onSnapshot(collection(db, "orders"), (snap) => {
    if (snap.empty) {
      tbody.innerHTML = '<tr><td colspan="6">No orders yet.</td></tr>';
      return;
    }

    const orders = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

    tbody.innerHTML = orders
      .map(
        (o) => `
        <tr>
          <td>${(o.service || "").replace(/_/g, " ")}</td>
          <td style="max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${o.link || ""}</td>
          <td>${o.quantity || 0}</td>
          <td>${formatNaira(o.cost)}</td>
          <td>${badge(o.status)}</td>
          <td>
            <select data-order-status="${o.id}" class="btn-small" style="padding:4px 8px;">
              <option value="pending" ${o.status === "pending" ? "selected" : ""}>Pending</option>
              <option value="processing" ${o.status === "processing" ? "selected" : ""}>Processing</option>
              <option value="completed" ${o.status === "completed" ? "selected" : ""}>Completed</option>
              <option value="failed" ${o.status === "failed" ? "selected" : ""}>Failed</option>
            </select>
          </td>
        </tr>`
      )
      .join("");

    tbody.querySelectorAll("[data-order-status]").forEach((select) => {
      select.addEventListener("change", async () => {
        const orderId = select.dataset.orderStatus;
        try {
          await updateDoc(doc(db, "orders", orderId), { status: select.value });
        } catch (err) {
          console.error(err);
        }
      });
    });
  });
}

// ---- Settings ----
function wireSettings() {
  const form = document.getElementById("settingsForm");
  if (!form) return;

  const settingsRef = doc(db, "settings", "bankDetails");

  getDoc(settingsRef).then((snap) => {
    if (snap.exists()) {
      const data = snap.data();
      document.getElementById("bankName").value = data.bankName || "";
      document.getElementById("accountName").value = data.accountName || "";
      document.getElementById("accountNumber").value = data.accountNumber || "";
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("settingsError");
    const successEl = document.getElementById("settingsSuccess");
    const submitBtn = form.querySelector("button[type='submit']");

    errorEl.classList.remove("visible");
    successEl.style.display = "none";
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving...";

    try {
      await setDoc(settingsRef, {
        bankName: document.getElementById("bankName").value.trim(),
        accountName: document.getElementById("accountName").value.trim(),
        accountNumber: document.getElementById("accountNumber").value.trim()
      });
      successEl.textContent = "Settings saved.";
      successEl.style.display = "block";
    } catch (err) {
      errorEl.textContent = "Could not save settings.";
      errorEl.classList.add("visible");
      console.error(err);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save settings";
    }
  });
}
