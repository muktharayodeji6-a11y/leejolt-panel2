/**
 * Leejolt Panel — Cloudflare Worker
 * ------------------------------------------------------------------
 * Replaces the Firebase Cloud Function bridge. Runs entirely on
 * Cloudflare's free tier — no card required.
 *
 * Two jobs, one file:
 *
 * 1. fetch handler — an HTTP endpoint the frontend calls (with the
 *    user's Firebase ID token) right after creating a "pending" order
 *    doc + deducting wallet balance. Splits the order into randomized
 *    drip-feed batches and schedules them in Firestore.
 *
 * 2. scheduled handler — runs on a Cron Trigger (set in the Cloudflare
 *    dashboard, e.g. every 10 minutes). Sends up to 2 due batches to
 *    Betalogs and updates progress on the parent order.
 *
 * ---- Required environment variables / secrets (set in the Cloudflare
 * dashboard under Worker > Settings > Variables) ----
 *   BETALOGS_API_KEY        (secret)  your real Betalogs API key
 *   FIREBASE_SERVICE_ACCOUNT (secret) full contents of your Firebase
 *                                     service account JSON key file
 *   FIREBASE_PROJECT_ID      (plain)  e.g. "leejolt-panel"
 *   ALLOWED_ORIGIN            (plain) your GitHub Pages URL, e.g.
 *                                     "https://you.github.io"
 * ------------------------------------------------------------------
 */

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
const QUIET_HOUR_END_WAT = 6;     // 6am
const DELIVERY_WINDOW_HOURS = 24;
const BATCH_MIN = 100;
const BATCH_MAX = 300;
const BATCH_PROCESS_LIMIT = 2;
const PEAK_HOURS_WAT = [8, 9, 10, 12, 13, 17, 18, 19, 20, 21, 22];

// ==================================================================
// Entry points
// ==================================================================
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return corsResponse(env, new Response(null, { status: 204 }));
    }
    if (request.method !== "POST") {
      return corsResponse(env, jsonResponse({ error: "Method not allowed" }, 405));
    }

    try {
      const authHeader = request.headers.get("Authorization") || "";
      const idToken = authHeader.replace(/^Bearer\s+/i, "");
      if (!idToken) {
        return corsResponse(env, jsonResponse({ error: "Missing auth token" }, 401));
      }

      const decoded = await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
      const uid = decoded.sub;

      const body = await request.json();
      const { orderId, service, link, quantity } = body;

      if (!orderId || !service || !link || !quantity) {
        return corsResponse(env, jsonResponse({ error: "Missing required fields" }, 400));
      }
      if (!SERVICE_MAP[service]) {
        return corsResponse(env, jsonResponse({ error: "Unknown service" }, 400));
      }

      const accessToken = await getFirestoreAccessToken(env);
      const order = await firestoreGet(env, accessToken, `orders/${orderId}`);

      if (!order) {
        return corsResponse(env, jsonResponse({ error: "Order not found" }, 404));
      }
      if (order.userId !== uid) {
        return corsResponse(env, jsonResponse({ error: "This order does not belong to you" }, 403));
      }

      const batchSizes = generateBatchPlan(quantity);
      const scheduleTimes = assignScheduleTimes(batchSizes.length);

      for (let i = 0; i < batchSizes.length; i++) {
        await firestoreCreate(env, accessToken, `orders/${orderId}/batches`, {
          orderId,
          service,
          link,
          quantity: batchSizes[i],
          scheduledAt: scheduleTimes[i].toISOString(),
          status: "pending",
          createdAt: new Date().toISOString(),
        });
      }

      await firestorePatch(env, accessToken, `orders/${orderId}`, {
        status: "processing",
        totalBatches: batchSizes.length,
        deliveredBatches: 0,
        deliveredQuantity: 0,
      });

      return corsResponse(env, jsonResponse({ success: true, totalBatches: batchSizes.length }));
    } catch (err) {
      console.error(err);
      return corsResponse(env, jsonResponse({ error: err.message || "Internal error" }, 500));
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processDueBatches(env));
  },
};

// ==================================================================
// Drip-feed batch planning
// ==================================================================
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateBatchPlan(totalQuantity) {
  const batches = [];
  let remaining = totalQuantity;
  while (remaining > 0) {
    if (remaining <= BATCH_MAX) {
      batches.push(remaining);
      break;
    }
    let size = randomInt(BATCH_MIN, BATCH_MAX);
    if (remaining - size < BATCH_MIN) size = remaining;
    batches.push(size);
    remaining -= size;
  }
  return batches;
}

function watHourOf(date) {
  return (date.getUTCHours() + 1) % 24; // Nigeria = UTC+1, no DST
}

function avoidQuietHours(date) {
  const hour = watHourOf(date);
  if (hour >= QUIET_HOUR_START_WAT && hour < QUIET_HOUR_END_WAT) {
    date.setUTCHours(date.getUTCHours() + (QUIET_HOUR_END_WAT - hour));
  }
  return date;
}

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

    if (!PEAK_HOURS_WAT.includes(watHourOf(candidate)) && Math.random() < 0.4) {
      const targetHour = PEAK_HOURS_WAT[randomInt(0, PEAK_HOURS_WAT.length - 1)];
      candidate.setUTCHours(candidate.getUTCHours() + (targetHour - watHourOf(candidate)));
      candidate = avoidQuietHours(candidate);
    }
    times.push(candidate);
  }

  times.sort((a, b) => a - b);
  return times;
}

// ==================================================================
// Scheduled batch processing
// ==================================================================
async function processDueBatches(env) {
  const currentWATHour = watHourOf(new Date());
  if (currentWATHour >= QUIET_HOUR_START_WAT && currentWATHour < QUIET_HOUR_END_WAT) {
    console.log("Quiet hours — skipping this run.");
    return;
  }

  const accessToken = await getFirestoreAccessToken(env);
  const dueBatches = await firestoreQueryDueBatches(env, accessToken);

  if (!dueBatches.length) {
    console.log("No due batches this run.");
    return;
  }

  for (const batch of dueBatches) {
    try {
      const params = new URLSearchParams({
        key: env.BETALOGS_API_KEY,
        action: "add",
        service: String(SERVICE_MAP[batch.fields.service]),
        link: batch.fields.link,
        quantity: String(batch.fields.quantity),
      });

      const res = await fetch(BETALOGS_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
