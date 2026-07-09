// orders.js - Handles growth-plan order submission and order history display
import {
  db,
  auth,
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

// The deployed Cloudflare Worker that holds the real Betalogs API key
// server-side, serves the live service catalog, and plans the
// drip-feed batches for each order.
const ORDER_WORKER_URL = "https://leejolt-panel2.muktharayodeji6.workers.dev";

const MAX_SERVICE_ROWS = 3;
const STAGGER_FRACTION = 0.4; // use at most 40% of the window to stagger starts
const MIN_STAGGER_MINUTES = 20; // each service should visibly start after the last, not blur together

let servicesCatalog = []; // populated from the Worker on page load

function formatNaira(amount) {
  return "\u20a6" + Number(amount || 0).toLocaleString("en-NG", { minimumFractionDigits: 2 });
}

function serviceOptionsHTML() {
  return (
    '<option value="">Select a service</option>' +
    servicesCatalog
      .map(
        (s) =>
          `<option value="${s.service}" data-rate="${s.rate}" data-min="${s.min}" data-max="${s.max}">${s.name} - ${formatNaira(s.rate)}/1000</option>`
      )
      .join("")
  );
}

function renderServiceRows() {
  const container = document.getElementById("serviceRows");
  if (!container) return;

  let html = "";
  for (let i = 0; i < MAX_SERVICE_ROWS; i++) {
    html += `
      <div class="field" data-row="${i}" style="border-top: 1px solid var(--panel-border); padding-top: 14px; margin-top: 4px;">
        <span class="field-label">${i === 0 ? "Service 1 (required)" : `Service ${i + 1} (optional)`}</span>
        <select class="row-service" data-row="${i}">${serviceOptionsHTML()}</select>
        <input type="number" class="row-quantity" data-row="${i}" min="0" step="100" placeholder="Quantity" style="margin-top: 8px;" />
      </div>`;
  }
  container.innerHTML = html;

  container.querySelectorAll(".row-service, .row-quantity").forEach((el) => {
    el.addEventListener("change", updateEstimatedCost);
    el.addEventListener("input", updateEstimatedCost);
  });
}

// ---- Load live service catalog from the Worker ----
async function loadServices() {
  try {
    const res = await fetch(ORDER_WORKER_URL, { method: "GET" });
    const data = await res.json();
    if (!res.ok || !Array.isArray(data.services)) throw new Error(data.error || "Failed to load services");

    servicesCatalog = data.services;
    renderServiceRows();
  } catch (err) {
    console.error("Failed to load services:", err);
    const container = document.getElementById("serviceRows");
    if (container) container.innerHTML = '<p class="form-error visible">Could not load services - refresh to retry.</p>';
  }
}

function getFilledRows() {
  const rows = [];
  document.querySelectorAll("#serviceRows [data-row]").forEach((rowEl) => {
    const select = rowEl.querySelector(".row-service");
    const qtyInput = rowEl.querySelector(".row-quantity");
    if (!select || !qtyInput) return;

    const quantity = parseInt(qtyInput.value, 10);
    if (!select.value || !quantity) return;

    const option = select.options[select.selectedIndex];
    rows.push({
      serviceId: select.value,
      serviceName: option.textContent.split(" - ")[0],
      rate: parseFloat(option.dataset.rate || 0),
      min: parseInt(option.dataset.min || 0, 10),
      max: parseInt(option.dataset.max || 0, 10),
      quantity
    });
  });
  return rows;
}

function updateEstimatedCost() {
  const estimateEl = document.getElementById("estimatedCost");
  if (!estimateEl) return;

  const rows = getFilledRows();
  if (rows.length === 0) {
    estimateEl.textContent = "";
    return;
  }

  const total = rows.reduce((sum, r) => sum + (r.rate / 1000) * r.quantity, 0);
  estimateEl.textContent = `Estimated total: ${formatNaira(total)} across ${rows.length} service${rows.length > 1 ? "s" : ""}`;
}

document.addEventListener("DOMContentLoaded", () => {
  loadServices();
  document.getElementById("completeByHours")?.addEventListener("input", updateEstimatedCost);
});

// ---- Submit growth plan ----
const form = document.getElementById("newOrderForm");
if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const user = auth.currentUser;
    if (!user) return;

    const errorEl = document.getElementById("orderError");
    const successEl = document.getElementById("orderSuccess");
    const submitBtn = form.querySelector("button[type='submit']");

    errorEl.classList.remove("visible");
    successEl.style.display = "none";

    const link = document.getElementById("link").value.trim();
    const completeByHours = parseFloat(document.getElementById("completeByHours").value);
    const rows = getFilledRows();

    if (!link) {
      errorEl.textContent = "Enter the link you want to grow.";
      errorEl.classList.add("visible");
      return;
    }
    if (!completeByHours || completeByHours < 0.25) {
      errorEl.textContent = "Enter how many hours from now this plan should complete (minimum 0.25).";
      errorEl.classList.add("visible");
      return;
    }
    if (rows.length === 0) {
      errorEl.textContent = "Pick at least one service.";
      errorEl.classList.add("visible");
      return;
    }

    const completeByDate = new Date(Date.now() + completeByHours * 3600000);
    const totalWindowMinutes = completeByHours * 60;
    if (totalWindowMinutes < 15) {
      errorEl.textContent = "Deadline must be at least 15 minutes from now.";
      errorEl.classList.add("visible");
      return;
    }

    if (rows.length > 1) {
      const neededMinutes = MIN_STAGGER_MINUTES * (rows.length - 1) + 15;
      if (totalWindowMinutes < neededMinutes) {
        errorEl.textContent = `With ${rows.length} services, choose at least ${Math.ceil(neededMinutes / 60 * 10) / 10} hours so each one has room to visibly follow the last.`;
        errorEl.classList.add("visible");
        return;
      }
    }

    for (const row of rows) {
      if (row.min && row.quantity < row.min) {
        errorEl.textContent = `Minimum quantity for ${row.serviceName} is ${row.min}.`;
        errorEl.classList.add("visible");
        return;
      }
      if (row.max && row.quantity > row.max) {
        errorEl.textContent = `Maximum quantity for ${row.serviceName} is ${row.max}.`;
        errorEl.classList.add("visible");
        return;
      }
    }

    const totalCost = rows.reduce((sum, r) => sum + (r.rate / 1000) * r.quantity, 0);

    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting...";

    try {
      const userRef = doc(db, "users", user.uid);
      const userSnap = await getDoc(userRef);
      const balance = userSnap.exists() ? userSnap.data().walletBalance || 0 : 0;

      if (balance < totalCost) {
        errorEl.textContent = `Insufficient balance. This plan costs ${formatNaira(totalCost)}, your wallet has ${formatNaira(balance)}. Please fund your wallet.`;
        errorEl.classList.add("visible");
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit growth plan";
        return;
      }

      await updateDoc(userRef, { walletBalance: increment(-totalCost) });

      const idToken = await auth.currentUser.getIdToken();
      const stepMinutes = Math.max(MIN_STAGGER_MINUTES, (totalWindowMinutes * STAGGER_FRACTION) / rows.length);

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const cost = (row.rate / 1000) * row.quantity;

        const orderDoc = await addDoc(collection(db, "orders"), {
          userId: user.uid,
          serviceId: row.serviceId,
          serviceName: row.serviceName,
          rate: row.rate,
          link,
          quantity: row.quantity,
          cost,
          completeBy: completeByDate.toISOString(),
          sequencePosition: i,
          status: "pending",
          createdAt: serverTimestamp()
        });

        try {
          const res = await fetch(ORDER_WORKER_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${idToken}`
            },
            body: JSON.stringify({
              orderId: orderDoc.id,
              serviceId: row.serviceId,
              link,
              quantity: row.quantity,
              completeBy: completeByDate.toISOString(),
              startOffsetMinutes: Math.round(stepMinutes * i),
              serviceMin: row.min
            })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Worker request failed");
        } catch (apiErr) {
          console.warn(`Order ${orderDoc.id} saved but Worker call failed, will need manual review:`, apiErr);
        }
      }

      successEl.textContent = `Growth plan submitted: ${rows.length} service${rows.length > 1 ? "s" : ""} scheduled to complete by ${completeByDate.toLocaleString()}.`;
      successEl.style.display = "block";
      form.reset();
      renderServiceRows();
      updateEstimatedCost();
    } catch (err) {
      errorEl.textContent = "Something went wrong. Please try again.";
      errorEl.classList.add("visible");
      console.error(err);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit growth plan";
    }
  });
}

// ---- Order history with expandable batch tracking ----
const batchListeners = new Map(); // orderId -> unsubscribe function
const expandedOrders = new Set();

function formatTime(isoOrTimestamp) {
  if (!isoOrTimestamp) return "-";
  const date = isoOrTimestamp.seconds
    ? new Date(isoOrTimestamp.seconds * 1000)
    : new Date(isoOrTimestamp);
  return date.toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short" });
}

function renderBatchDetails(orderId, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;

  if (batchListeners.has(orderId)) return; // already subscribed

  const unsub = onSnapshot(collection(db, "orders", orderId, "batches"), (snap) => {
    const batches = snap.docs
      .map((d) => d.data())
      .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));

    const sent = batches.filter((b) => b.status === "sent").length;
    const failed = batches.filter((b) => b.status === "failed").length;
    const pending = batches.filter((b) => b.status === "pending").length;
    const remainingQty = batches
      .filter((b) => b.status !== "sent")
      .reduce((sum, b) => sum + (b.quantity || 0), 0);

    el.innerHTML = `
      <div style="font-size: 12px; color: var(--text-muted); margin: 10px 0; display: flex; gap: 14px; flex-wrap: wrap;">
        <span><b style="color: var(--text);">${batches.length}</b> total batches</span>
        <span style="color: var(--green);"><b>${sent}</b> sent</span>
        <span style="color: var(--gold);"><b>${pending}</b> pending</span>
        ${failed ? `<span style="color: var(--red);"><b>${failed}</b> failed</span>` : ""}
        <span><b style="color: var(--text);">${remainingQty}</b> units remaining</span>
      </div>
      <div style="max-height: 220px; overflow-y: auto;">
        ${batches
          .map((b, i) => {
            const statusColor =
              b.status === "sent" ? "var(--green)" : b.status === "failed" ? "var(--red)" : "var(--gold)";
            return `
          <div style="display:flex; justify-content:space-between; padding: 6px 0; font-size: 12px; border-top: 1px solid var(--panel-border);">
            <span>Batch ${i + 1}: ${b.quantity} units</span>
            <span>${formatTime(b.scheduledAt)}</span>
            <span style="text-transform: capitalize; color: ${statusColor};">${b.status || "pending"}</span>
          </div>`;
          })
          .join("")}
      </div>`;
  });

  batchListeners.set(orderId, unsub);
}

function toggleOrderDetails(orderId) {
  const containerId = `batches-${orderId}`;
  const container = document.getElementById(containerId);
  if (!container) return;

  if (expandedOrders.has(orderId)) {
    expandedOrders.delete(orderId);
    container.style.display = "none";
    batchListeners.get(orderId)?.();
    batchListeners.delete(orderId);
  } else {
    expandedOrders.add(orderId);
    container.style.display = "block";
    renderBatchDetails(orderId, containerId);
  }
}
window.toggleOrderDetails = toggleOrderDetails;

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
        <div style="padding:12px 0; border-bottom:1px solid var(--panel-border);">
          <div style="display:flex; justify-content:space-between; align-items:center; gap: 12px; flex-wrap: wrap; cursor: pointer;" onclick="toggleOrderDetails('${o.id}')">
            <div>
              <div style="color: var(--text); font-weight: 500;">${o.serviceName || "Service"}</div>
              <div style="font-size: 12px;">${o.quantity} units - ${formatNaira(o.cost)}</div>
            </div>
            <span style="text-transform: capitalize; color: ${o.status === "completed" ? "var(--green)" : "var(--gold)"};">${o.status || "pending"} \u25be</span>
          </div>
          <div id="batches-${o.id}" style="display:none;"></div>
        </div>`
      )
      .join("");
  });
});
