/**
 * functions/index.js
 * ------------------------------------------------------------------
 * Firebase Cloud Functions for Leejolt Panel.
 *
 * Two functions:
 *
 * 1. createOrder (callable)
 *    Called by the frontend right after an order doc + wallet deduction
 *    are created. Instead of sending the whole quantity to Betalogs at
 *    once, it splits the order into randomized batches and schedules
 *    each one for a randomized time within the delivery window, while
 *    avoiding quiet hours.
 *
 * 2. processDueBatches (scheduled, runs every 10 minutes)
 *    Picks up to BATCH_PROCESS_LIMIT batches that are due, sends each
 *    one to Betalogs, and updates progress on the parent order.
 *
 * Deploy with: firebase deploy --only functions
 * ------------------------------------------------------------------
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Store your real Betalogs API key as a Firebase secret, never in code:
//   firebase functions:secrets:set BETALOGS_API_KEY
const BETALOGS_API_KEY = defineSecret("BETALOGS_API_KEY");

// TODO: replace with your real Betalogs API endpoint
const BETALOGS_API_URL = "https://betalogs.example/api/v2";

// TODO: replace with your real Betalogs service IDs
const SERVICE_MAP = {
  instagram_followers: 1001,
  instagram_likes: 1002,
  instagram_views: 1003,
  tiktok_followers: 2001,
  tiktok_likes: 2002,
  tiktok_views: 2003,
};

// ---- Drip-feed configuration ----
const QUIET_HOUR_START_WAT = 0;   // 12am
const QUIET_HOUR_END_WAT = 6;     // 6am (quiet window is [0,6) WAT)
const DELIVERY_WINDOW_HOURS = 24; // spread a full order's batches across 24h
const BATCH_MIN = 100;
const BATCH_MAX = 300;
const BATCH_PROCESS_LIMIT = 2;    // process at most 2 due batches per scheduled run
// Hours (WAT) with higher Nigerian audience activity — batches are weighted
// toward landing in these hours where possible.
const PEAK_HOURS_WAT = [8, 9, 10, 12, 13, 17, 18, 19, 20, 21, 22];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Splits a total quantity into randomized batch sizes between
// BATCH_MIN and BATCH_MAX, avoiding a tiny leftover final batch.
function generateBatchPlan(totalQuantity) {
  const batches = [];
  let remaining = totalQuantity;

  while (remaining > 0) {
    if (remaining <= BATCH_MAX) {
      batches.push(remaining);
      remaining = 0;
      break;
    }
    let size = randomInt(BATCH_MIN, BATCH_MAX);
    if (remaining - size < BATCH_MIN) size = remaining; // fold small remainder into this batch
    batches.push(size);
    remaining -= size;
  }

  return batches;
}

function watHourOf(date) {
  return (date.getUTCHours() + 1) % 24; // Nigeria is UTC+1, no DST
}

// Nudges a candidate time forward, out of quiet hours, if needed.
function avoidQuietHours(date) {
  const hour = watHourOf(date);
  if (hour >= QUIET_HOUR_START_WAT && hour < QUIET_HOUR_END_WAT) {
    const hoursToAdd = QUIET_HOUR_END_WAT - hour;
    date.setUTCHours(date.getUTCHours() + hoursToAdd);
  }
  return date;
}

// Spreads `count` batch times across the delivery window, with jitter,
// biased toward peak activity hours, while skipping quiet hours.
function assignScheduleTimes(count) {
  const now = Date.now();
  const windowMs = DELIVERY_WINDOW_HOURS * 3600 * 1000;
  const slice = windowMs / count;

  const times = [];
  for (let i = 0; i < count; i++) {
    const base = now + slice * i;
    const jitter = randomInt(0, Math.floor(slice));
    let candidate = new Date(base + jitter);
    candidate = avoidQuietHours(candidate);

    // Light bias: if the candidate landed outside peak hours, there's a
    // chance we pull it toward the nearest peak hour on the same day.
    if (!PEAK_HOURS_WAT.includes(watHourOf(candidate)) && Math.random() < 0.4) {
      const targetHour = PEAK_HOURS_WAT[randomInt(0, PEAK_HOURS_WAT.length - 1)];
      const currentHour = watHourOf(candidate);
      candidate.setUTCHours(candidate.getUTCHours() + (targetHour - currentHour));
      candidate = avoidQuietHours(candidate);
    }

    times.push(candidate);
  }

  times.sort((a, b) => a - b);
  return times;
}

// ------------------------------------------------------------------
// createOrder — plans the drip-feed batches for a new order
// ------------------------------------------------------------------
exports.createOrder = onCall(
  { secrets: [BETALOGS_API_KEY] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in.");
    }

    const { orderId, service, link, quantity } = request.data;

    if (!orderId || !service || !link || !quantity) {
      throw new HttpsError("invalid-argument", "Missing required fields.");
    }
    if (!SERVICE_MAP[service]) {
      throw new HttpsError("invalid-argument", "Unknown service.");
    }

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      throw new HttpsError("not-found", "Order not found.");
    }
    if (orderSnap.data().userId !== request.auth.uid) {
      throw new HttpsError("permission-denied", "This order does not belong to you.");
    }

    const batchSizes = generateBatchPlan(quantity);
    const scheduleTimes = assignScheduleTimes(batchSizes.length);

    const writes = batchSizes.map((size, i) => {
      const batchRef = orderRef.collection("batches").doc();
      return batchRef.set({
        orderId,
        service,
        link,
        quantity: size,
        scheduledAt: admin.firestore.Timestamp.fromDate(scheduleTimes[i]),
        status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    await Promise.all(writes);

    await orderRef.update({
      status: "processing",
      totalBatches: batchSizes.length,
      deliveredBatches: 0,
      deliveredQuantity: 0,
    });

    return { success: true, totalBatches: batchSizes.length };
  }
);

// ------------------------------------------------------------------
// processDueBatches — runs every 10 minutes, sends due batches to Betalogs
// ------------------------------------------------------------------
exports.processDueBatches = onSchedule(
  { schedule: "every 10 minutes", secrets: [BETALOGS_API_KEY] },
  async () => {
    const currentWATHour = watHourOf(new Date());
    if (currentWATHour >= QUIET_HOUR_START_WAT && currentWATHour < QUIET_HOUR_END_WAT) {
      console.log("Within quiet hours — skipping this run.");
      return;
    }

    const now = admin.firestore.Timestamp.now();

    const dueBatches = await db
      .collectionGroup("batches")
      .where("status", "==", "pending")
      .where("scheduledAt", "<=", now)
      .orderBy("scheduledAt", "asc")
      .limit(BATCH_PROCESS_LIMIT)
      .get();

    if (dueBatches.empty) {
      console.log("No due batches this run.");
      return;
    }

    for (const batchDoc of dueBatches.docs) {
      const batch = batchDoc.data();
      const orderRef = db.collection("orders").doc(batch.orderId);

      try {
        const params = new URLSearchParams({
          key: BETALOGS_API_KEY.value(),
          action: "add",
          service: String(SERVICE_MAP[batch.service]),
          link: batch.link,
          quantity: String(batch.quantity),
        });

        const res = await fetch(BETALOGS_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        });

        const data = await res.json();
        if (!res.ok || data.error) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }

        await batchDoc.ref.update({
          status: "sent",
          betalogsOrderId: data.order || null,
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        await db.runTransaction(async (tx) => {
          const orderSnap = await tx.get(orderRef);
          if (!orderSnap.exists) return;

          const orderData = orderSnap.data();
          const deliveredBatches = (orderData.deliveredBatches || 0) + 1;
          const deliveredQuantity = (orderData.deliveredQuantity || 0) + batch.quantity;
          const isDone = deliveredBatches >= (orderData.totalBatches || 1);

          tx.update(orderRef, {
            deliveredBatches,
            deliveredQuantity,
            status: isDone ? "completed" : "processing",
          });
        });
      } catch (err) {
        console.error(`Batch ${batchDoc.id} failed:`, err.message);
        await batchDoc.ref.update({
          status: "failed",
          failureReason: err.message || "Unknown error",
        });
      }
    }
  }
);
