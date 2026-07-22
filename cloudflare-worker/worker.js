/**
 * Leejolt Panel - Cloudflare Worker
 * ------------------------------------------------------------------
 * Replaces the Firebase Cloud Function bridge. Runs entirely on
 * Cloudflare's free tier - no card required.
 *
 * Two jobs, one file:
 *
 * 1. fetch handler - an HTTP endpoint the frontend calls (with the
 *    user's Firebase ID token) right after creating a "pending" order
 *    doc + deducting wallet balance. Splits the order into randomized
 *    drip-feed batches and schedules them in Firestore.
 *
 * 2. scheduled handler - runs on a Cron Trigger (set in the Cloudflare
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
const BETALOGS_API_URL = "https://betalogs.com/api/smm/v1";

// Second provider - ChickletBoost. Uses POST (Betalogs uses GET), and its
// key lives in the CHICKLETBOOST_API_KEY secret (set in Cloudflare dashboard).
const CHICKLETBOOST_API_URL = "https://chickletboost.com/api/v2";

// Third provider being explored - TheKclaut, same POST-based API style.
const THEKCLAUT_API_URL = "https://thekclaut.com/api/v2";

// In-memory cache for the Betalogs service list (per Worker isolate)
let cachedServices = null;
let cachedServicesAt = 0;
const SERVICES_CACHE_MS = 10 * 60 * 1000; // 10 minutes

// ---- Drip-feed configuration ----
const QUIET_HOUR_START_WAT = 0;   // 12am
const QUIET_HOUR_END_WAT = 6;     // 6am
const DELIVERY_WINDOW_HOURS = 24;   // fallback default if no deadline given
const MIN_WINDOW_MINUTES = 15;      // deadline can't be sooner than this
const MAX_WINDOW_DAYS = 14;         // deadline can't be further than this
const BATCH_MIN = 20;

// TheKclaut's real per-order minimum (separate from Betalogs, which we
// already override to a 50-unit floor for Views on the frontend). Used
// when a batch gets randomly routed to TheKclaut in dual-provider mode.
// Can be overridden per-order via `serviceMinThekclaut` in the request.
const THEKCLAUT_DEFAULT_MIN = 100;
const BATCH_PROCESS_LIMIT = 2;

// ---- Rotating fixed drip-feed schedules (WAT / UTC+1 wall-clock times) ----
// Instead of generating random delays per order, each order is locked to
// ONE of these 20 predefined 24-hour schedules for its whole lifetime.
// Rotation (via pickNextSchedule) guarantees no schedule repeats until
// all 20 have been used at least once.
const SCHEDULE_BANK = [
  ["12:14 AM","1:51 AM","3:29 AM","5:02 AM","6:44 AM","8:13 AM","9:47 AM","11:26 AM","1:08 PM","2:43 PM","4:17 PM","5:56 PM","7:28 PM","9:11 PM","10:37 PM","11:54 PM"],
  ["12:31 AM","2:09 AM","3:42 AM","5:26 AM","6:53 AM","8:36 AM","10:01 AM","11:44 AM","1:12 PM","2:58 PM","4:33 PM","6:07 PM","7:46 PM","9:18 PM","10:52 PM","11:39 PM"],
  ["12:06 AM","1:48 AM","3:17 AM","4:59 AM","6:23 AM","8:05 AM","9:39 AM","11:14 AM","12:52 PM","2:31 PM","4:06 PM","5:41 PM","7:13 PM","8:57 PM","10:22 PM","11:48 PM"],
  ["12:27 AM","2:13 AM","3:55 AM","5:38 AM","7:09 AM","8:42 AM","10:16 AM","11:57 AM","1:33 PM","3:05 PM","4:49 PM","6:18 PM","7:59 PM","9:27 PM","10:46 PM","11:58 PM"],
  ["12:11 AM","1:59 AM","3:34 AM","5:07 AM","6:51 AM","8:26 AM","9:54 AM","11:38 AM","1:01 PM","2:46 PM","4:28 PM","6:02 PM","7:34 PM","9:09 PM","10:41 PM","11:53 PM"],
  ["12:19 AM","2:01 AM","3:47 AM","5:11 AM","6:46 AM","8:22 AM","10:04 AM","11:31 AM","1:16 PM","2:54 PM","4:39 PM","6:13 PM","7:51 PM","9:24 PM","10:58 PM","11:45 PM"],
  ["12:39 AM","2:18 AM","3:53 AM","5:27 AM","7:03 AM","8:41 AM","10:19 AM","11:49 AM","1:25 PM","3:02 PM","4:45 PM","6:21 PM","7:57 PM","9:36 PM","10:48 PM","11:56 PM"],
  ["12:08 AM","1:46 AM","3:31 AM","5:13 AM","6:58 AM","8:37 AM","9:59 AM","11:42 AM","1:14 PM","2:52 PM","4:26 PM","5:57 PM","7:41 PM","9:13 PM","10:39 PM","11:51 PM"],
  ["12:24 AM","2:12 AM","3:44 AM","5:21 AM","6:57 AM","8:18 AM","9:52 AM","11:36 AM","1:03 PM","2:49 PM","4:14 PM","5:48 PM","7:32 PM","9:08 PM","10:55 PM","11:43 PM"],
  ["12:17 AM","1:58 AM","3:36 AM","5:09 AM","6:43 AM","8:29 AM","10:08 AM","11:54 AM","1:18 PM","2:56 PM","4:31 PM","6:09 PM","7:47 PM","9:22 PM","10:44 PM","11:57 PM"],
  ["12:09 AM","1:53 AM","3:15 AM","4:57 AM","6:34 AM","8:07 AM","9:45 AM","11:27 AM","1:06 PM","2:48 PM","4:24 PM","5:59 PM","7:36 PM","9:17 PM","10:51 PM","11:49 PM"],
  ["12:33 AM","2:15 AM","3:58 AM","5:34 AM","7:12 AM","8:48 AM","10:23 AM","11:59 AM","1:37 PM","3:09 PM","4:53 PM","6:27 PM","8:01 PM","9:38 PM","10:57 PM","11:52 PM"],
  ["12:12 AM","1:49 AM","3:26 AM","5:05 AM","6:49 AM","8:24 AM","10:02 AM","11:40 AM","1:20 PM","2:59 PM","4:35 PM","6:08 PM","7:43 PM","9:19 PM","10:47 PM","11:55 PM"],
  ["12:28 AM","2:07 AM","3:51 AM","5:19 AM","6:55 AM","8:39 AM","10:11 AM","11:50 AM","1:29 PM","3:01 PM","4:46 PM","6:20 PM","7:58 PM","9:31 PM","10:53 PM","11:46 PM"],
  ["12:05 AM","1:44 AM","3:22 AM","4:55 AM","6:31 AM","8:14 AM","9:57 AM","11:34 AM","1:10 PM","2:44 PM","4:18 PM","5:55 PM","7:27 PM","9:04 PM","10:36 PM","11:50 PM"],
  ["12:21 AM","2:03 AM","3:49 AM","5:23 AM","7:01 AM","8:33 AM","10:07 AM","11:45 AM","1:22 PM","2:57 PM","4:41 PM","6:16 PM","7:52 PM","9:26 PM","10:49 PM","11:58 PM"],
  ["12:36 AM","2:19 AM","3:57 AM","5:32 AM","7:16 AM","8:54 AM","10:25 AM","11:56 AM","1:35 PM","3:12 PM","4:58 PM","6:35 PM","8:08 PM","9:41 PM","10:59 PM","11:47 PM"],
  ["12:15 AM","1:57 AM","3:38 AM","5:14 AM","6:47 AM","8:28 AM","10:03 AM","11:39 AM","1:13 PM","2:51 PM","4:29 PM","6:06 PM","7:40 PM","9:15 PM","10:43 PM","11:54 PM"],
  ["12:30 AM","2:11 AM","3:46 AM","5:25 AM","7:08 AM","8:46 AM","10:18 AM","11:52 AM","1:31 PM","3:07 PM","4:52 PM","6:24 PM","8:03 PM","9:34 PM","10:56 PM","11:48 PM"],
  ["12:10 AM","1:54 AM","3:33 AM","5:08 AM","6:45 AM","8:21 AM","9:58 AM","11:37 AM","1:15 PM","2:53 PM","4:37 PM","6:12 PM","7:49 PM","9:21 PM","10:45 PM","11:59 PM"],
];

// "12:14 AM" -> minutes since midnight, WAT wall-clock
function parseTimeToMinutes(timeStr) {
  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) throw new Error(`Bad time format: ${timeStr}`);
  let [, h, m, period] = match;
  h = parseInt(h, 10);
  m = parseInt(m, 10);
  period = period.toUpperCase();
  if (period === "AM") {
    if (h === 12) h = 0;
  } else if (h !== 12) {
    h += 12;
  }
  return h * 60 + m;
}

const SCHEDULE_BANK_MINUTES = SCHEDULE_BANK.map((sched) => sched.map(parseTimeToMinutes));

// ==================================================================
// Entry points
// ==================================================================
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return corsResponse(env, new Response(null, { status: 204 }));
    }

    // GET ?type=balance = your Betalogs provider balance (requires sign-in).
    // GET (no params) = public service list, no auth needed.
    if (request.method === "GET") {
      const url = new URL(request.url);

      if (url.searchParams.get("type") === "debug") {
        try {
          const authHeader = request.headers.get("Authorization") || "";
          const idToken = authHeader.replace(/^Bearer\s+/i, "");
          if (!idToken) {
            return corsResponse(env, jsonResponse({ error: "Missing auth token" }, 401));
          }
          await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);

          const orderId = url.searchParams.get("orderId");
          if (!orderId) {
            return corsResponse(env, jsonResponse({ error: "Pass ?orderId=... in the URL" }, 400));
          }

          const accessToken = await getFirestoreAccessToken(env);
          const listUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/orders/${orderId}/batches`;
          const res = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
          const raw = await res.json();

          return corsResponse(env, jsonResponse(raw));
        } catch (err) {
          console.error(err);
          return corsResponse(env, jsonResponse({ error: "Debug failed: " + (err.message || String(err)) }, 500));
        }
      }

      if (url.searchParams.get("type") === "process") {
        try {
          const authHeader = request.headers.get("Authorization") || "";
          const idToken = authHeader.replace(/^Bearer\s+/i, "");
          if (!idToken) {
            return corsResponse(env, jsonResponse({ error: "Missing auth token" }, 401));
          }
          await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);

          const result = await processDueBatches(env, true);
          return corsResponse(env, jsonResponse(result));
        } catch (err) {
          console.error(err);
          return corsResponse(env, jsonResponse({ error: "Process failed: " + (err.message || String(err)) }, 500));
        }
      }

      if (url.searchParams.get("type") === "balance") {
        try {
          const authHeader = request.headers.get("Authorization") || "";
          const idToken = authHeader.replace(/^Bearer\s+/i, "");
          if (!idToken) {
            return corsResponse(env, jsonResponse({ error: "Missing auth token" }, 401));
          }
          await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);

          const params = new URLSearchParams({ key: env.BETALOGS_API_KEY, action: "balance" });
          const res = await fetch(`${BETALOGS_API_URL}?${params.toString()}`);
          const data = await res.json();
          return corsResponse(env, jsonResponse(data));
        } catch (err) {
          console.error(err);
          return corsResponse(env, jsonResponse({ error: "Could not fetch balance: " + (err.message || String(err)) }, 502));
        }
      }

      // ---- ChickletBoost test endpoints (second provider) ----
      if (url.searchParams.get("type") === "cb-balance") {
        try {
          const authHeader = request.headers.get("Authorization") || "";
          const idToken = authHeader.replace(/^Bearer\s+/i, "");
          if (!idToken) {
            return corsResponse(env, jsonResponse({ error: "Missing auth token" }, 401));
          }
          await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);

          const data = await callChickletBoost(env, "balance");
          return corsResponse(env, jsonResponse(data));
        } catch (err) {
          console.error(err);
          return corsResponse(env, jsonResponse({ error: "Could not fetch CB balance: " + (err.message || String(err)) }, 502));
        }
      }

      if (url.searchParams.get("type") === "cb-services") {
        try {
          const authHeader = request.headers.get("Authorization") || "";
          const idToken = authHeader.replace(/^Bearer\s+/i, "");
          if (!idToken) {
            return corsResponse(env, jsonResponse({ error: "Missing auth token" }, 401));
          }
          await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);

          const services = await getChickletBoostServices(env);
          return corsResponse(env, jsonResponse({ services }));
        } catch (err) {
          console.error(err);
          return corsResponse(env, jsonResponse({ error: "Could not load CB services: " + (err.message || String(err)) }, 502));
        }
      }

      // ---- TheKclaut test endpoints (third provider being explored) ----
      if (url.searchParams.get("type") === "tk-balance") {
        try {
          const authHeader = request.headers.get("Authorization") || "";
          const idToken = authHeader.replace(/^Bearer\s+/i, "");
          if (!idToken) {
            return corsResponse(env, jsonResponse({ error: "Missing auth token" }, 401));
          }
          await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);

          const data = await callTheKclaut(env, "balance");
          return corsResponse(env, jsonResponse(data));
        } catch (err) {
          console.error(err);
          return corsResponse(env, jsonResponse({ error: "Could not fetch TK balance: " + (err.message || String(err)) }, 502));
        }
      }

      if (url.searchParams.get("type") === "tk-services") {
        try {
          const authHeader = request.headers.get("Authorization") || "";
          const idToken = authHeader.replace(/^Bearer\s+/i, "");
          if (!idToken) {
            return corsResponse(env, jsonResponse({ error: "Missing auth token" }, 401));
          }
          await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);

          const services = await getTheKclautServices(env);
          return corsResponse(env, jsonResponse({ services }));
        } catch (err) {
          console.error(err);
          return corsResponse(env, jsonResponse({ error: "Could not load TK services: " + (err.message || String(err)) }, 502));
        }
      }

      try {
        const services = await getBetalogsServices(env);
        return corsResponse(env, jsonResponse({ services }));
      } catch (err) {
        console.error(err);
        return corsResponse(env, jsonResponse({ error: "Could not load services" }, 502));
      }
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

      // ---- Cancel an order ----
      if (body.action === "cancel") {
        const { orderId } = body;
        if (!orderId) {
          return corsResponse(env, jsonResponse({ error: "Missing orderId" }, 400));
        }

        const accessToken = await getFirestoreAccessToken(env);
        const order = await firestoreGet(env, accessToken, `orders/${orderId}`);

        if (!order) {
          return corsResponse(env, jsonResponse({ error: "Order not found" }, 404));
        }
        if (order.userId !== uid) {
          return corsResponse(env, jsonResponse({ error: "This order does not belong to you" }, 403));
        }
        if (order.status === "completed" || order.status === "cancelled") {
          return corsResponse(env, jsonResponse({ error: `Order already ${order.status}, nothing to cancel` }, 400));
        }

        const listUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/orders/${orderId}/batches`;
        const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
        const listData = await listRes.json();
        const batchDocs = listData.documents || [];

        const pendingDocs = batchDocs.filter((doc) => {
          const fields = firestoreValueToJS(doc.fields);
          return fields.status === "pending";
        });

        const cancelledCount = await firestoreBatchUpdateStatus(env, accessToken, pendingDocs, "cancelled");

        await firestorePatch(env, accessToken, `orders/${orderId}`, { status: "cancelled" });

        return corsResponse(env, jsonResponse({ success: true, cancelledBatches: cancelledCount }));
      }

      // ---- Create a new order ----
      const {
        orderId,
        serviceId,
        serviceIdBetalogs,
        serviceIdThekclaut,
        link,
        quantity,
        completeBy,
        startOffsetMinutes,
        serviceMin,
        provider,
      } = body;
      const targetProvider = provider === "thekclaut" ? "thekclaut" : "betalogs"; // defaults to betalogs

      // Dual-provider mode: when the frontend supplies a service ID for
      // BOTH Betalogs and TheKclaut (e.g. for Views), each batch is
      // randomly routed to one provider or the other using that
      // provider's own service ID. Every other service keeps using the
      // single serviceId/targetProvider path, unchanged.
      const dualProviderIds = serviceIdBetalogs && serviceIdThekclaut
        ? { betalogs: serviceIdBetalogs, thekclaut: serviceIdThekclaut }
        : null;

      if (!orderId || (!serviceId && !dualProviderIds) || !link || !quantity) {
        return corsResponse(env, jsonResponse({ error: "Missing required fields" }, 400));
      }

      // Work out the delivery window: either the person's chosen deadline,
      // clamped to sane min/max bounds, or the default 24h window.
      let windowMs = DELIVERY_WINDOW_HOURS * 3600 * 1000;
      if (completeBy) {
        const deadlineMs = new Date(completeBy).getTime() - Date.now();
        if (isNaN(deadlineMs)) {
          return corsResponse(env, jsonResponse({ error: "Invalid deadline" }, 400));
        }
        const minMs = MIN_WINDOW_MINUTES * 60 * 1000;
        const maxMs = MAX_WINDOW_DAYS * 24 * 3600 * 1000;
        if (deadlineMs < minMs) {
          return corsResponse(env, jsonResponse({ error: `Deadline must be at least ${MIN_WINDOW_MINUTES} minutes from now` }, 400));
        }
        windowMs = Math.min(deadlineMs, maxMs);
      }

      // For multi-service "growth plan" orders sharing one link, each
      // service can start a bit later than the last so engagement types
      // land in a staggered, natural-looking order (e.g. views first,
      // then likes, then follows) instead of all at once.
      const offsetMs = Math.max(0, (startOffsetMinutes || 0) * 60 * 1000);
      const remainingWindowMs = windowMs - offsetMs;
      if (remainingWindowMs < MIN_WINDOW_MINUTES * 60 * 1000) {
        return corsResponse(env, jsonResponse({ error: "Not enough time left in the window for this service's stagger position" }, 400));
      }

      const accessToken = await getFirestoreAccessToken(env);
      const order = await firestoreGet(env, accessToken, `orders/${orderId}`);

      if (!order) {
        return corsResponse(env, jsonResponse({ error: "Order not found" }, 404));
      }
      if (order.userId !== uid) {
        return corsResponse(env, jsonResponse({ error: "This order does not belong to you" }, 403));
      }

      const scheduleIndex = await pickNextSchedule(env, accessToken);

      let batchSizes, scheduleTimes, batchProviders;

      if (dualProviderIds) {
        const betalogsMin = Math.max(1, serviceMin || BATCH_MIN); // your 50-unit Views override
        const thekclautMin = Math.max(1, body.serviceMinThekclaut || THEKCLAUT_DEFAULT_MIN); // 100
        const planned = planDualProviderScheduleBatches(
          scheduleIndex,
          quantity,
          betalogsMin,
          thekclautMin,
          remainingWindowMs,
          offsetMs
        );
        batchSizes = planned.batchSizes;
        scheduleTimes = planned.scheduleTimes;
        batchProviders = planned.batchProviders;
      } else {
        const effectiveMin = Math.max(1, serviceMin || BATCH_MIN);
        const planned = planScheduleBatches(scheduleIndex, quantity, effectiveMin, remainingWindowMs, offsetMs);
        batchSizes = planned.batchSizes;
        scheduleTimes = planned.scheduleTimes;
        batchProviders = null;
      }

      for (let i = 0; i < batchSizes.length; i++) {
        const batchProvider = dualProviderIds ? batchProviders[i] : targetProvider;
        const batchServiceId = dualProviderIds ? dualProviderIds[batchProvider] : serviceId;

        await firestoreCreate(env, accessToken, `orders/${orderId}/batches`, {
          orderId,
          serviceId: batchServiceId,
          provider: batchProvider,
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
        scheduleIndex, // locks refills/edits to the same fixed schedule
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

// Fetches (and caches) the live Betalogs service catalog.
async function getBetalogsServices(env) {
  if (cachedServices && Date.now() - cachedServicesAt < SERVICES_CACHE_MS) {
    return cachedServices;
  }

  const params = new URLSearchParams({ key: env.BETALOGS_API_KEY, action: "services" });
  const res = await fetch(`${BETALOGS_API_URL}?${params.toString()}`);
  const data = await res.json();

  if (!Array.isArray(data)) throw new Error("Unexpected services response");

  cachedServices = data;
  cachedServicesAt = Date.now();
  return data;
}

// ---- ChickletBoost (second provider, POST-based API) ----
let cachedCBServices = null;
let cachedCBServicesAt = 0;

async function callPostBasedProvider(apiUrl, apiKey, action, extraFields = {}) {
  const body = new URLSearchParams({
    key: apiKey,
    action,
    ...extraFields,
  });

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  return res.json();
}

async function callChickletBoost(env, action, extraFields = {}) {
  return callPostBasedProvider(CHICKLETBOOST_API_URL, env.CHICKLETBOOST_API_KEY, action, extraFields);
}

async function getChickletBoostServices(env) {
  if (cachedCBServices && Date.now() - cachedCBServicesAt < SERVICES_CACHE_MS) {
    return cachedCBServices;
  }

  const data = await callChickletBoost(env, "services");
  if (!Array.isArray(data)) throw new Error("Unexpected services response");

  cachedCBServices = data;
  cachedCBServicesAt = Date.now();
  return data;
}

// ---- TheKclaut (third provider being explored, same POST style) ----
let cachedTKServices = null;
let cachedTKServicesAt = 0;

async function callTheKclaut(env, action, extraFields = {}) {
  return callPostBasedProvider(THEKCLAUT_API_URL, env.THEKCLAUT_API_KEY, action, extraFields);
}

async function getTheKclautServices(env) {
  if (cachedTKServices && Date.now() - cachedTKServicesAt < SERVICES_CACHE_MS) {
    return cachedTKServices;
  }

  const data = await callTheKclaut(env, "services");
  if (!Array.isArray(data)) throw new Error("Unexpected services response");

  cachedTKServices = data;
  cachedTKServicesAt = Date.now();
  return data;
}

// ==================================================================
// Drip-feed batch planning - rotating fixed schedules
// ==================================================================
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function watHourOf(date) {
  return (date.getUTCHours() + 1) % 24; // Nigeria = UTC+1, no DST
}

function shuffledIndices(n) {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Picks the next schedule index for a new order, never repeating any
// schedule until all 20 have been used ("shuffle bag"). State lives in
// Firestore (system/schedule_rotation) since Workers are stateless
// between requests. Pool is stored as a comma-joined string since the
// existing firestoreValueToJS/jsToFirestoreFields helpers don't handle
// Firestore arrayValue.
//
// NOTE: this is a plain read-then-write, not a Firestore transaction.
// Under a burst of simultaneous order creations two orders could in
// theory pop the same index - a non-issue at normal panel volumes, but
// worth knowing if you ever see a suspicious repeat.
async function pickNextSchedule(env, accessToken) {
  const state = await firestoreGet(env, accessToken, "system/schedule_rotation");
  let pool = state && state.pool ? state.pool.split(",").filter(Boolean).map(Number) : [];

  if (pool.length === 0) {
    pool = shuffledIndices(SCHEDULE_BANK.length);
  }

  const chosenIndex = pool.pop();
  await firestorePatch(env, accessToken, "system/schedule_rotation", {
    pool: pool.join(","),
  });

  return chosenIndex;
}

// Builds every wall-clock slot (as UTC Date objects) from the chosen
// schedule that falls within [startDate, startDate + windowMs]. Schedule
// times are WAT (UTC+1) wall-clock, so each slot's UTC time is the WAT
// minute-of-day minus 60 minutes.
function buildScheduleSlots(scheduleIndex, startDate, windowMs) {
  const slotsWAT = SCHEDULE_BANK_MINUTES[scheduleIndex];
  const endDate = new Date(startDate.getTime() + windowMs);

  // Walk from the day before startDate through the day after endDate so
  // no boundary slot gets missed by the WAT->UTC shift.
  const dayCursor = new Date(startDate);
  dayCursor.setUTCHours(0, 0, 0, 0);
  dayCursor.setUTCDate(dayCursor.getUTCDate() - 1);

  const lastDay = new Date(endDate);
  lastDay.setUTCHours(0, 0, 0, 0);
  lastDay.setUTCDate(lastDay.getUTCDate() + 1);

  const slots = [];
  while (dayCursor <= lastDay) {
    for (const watMinutes of slotsWAT) {
      const utcMinutes = watMinutes - 60; // WAT = UTC+1
      const slotTime = new Date(dayCursor.getTime() + utcMinutes * 60000);
      if (slotTime >= startDate && slotTime <= endDate) {
        slots.push(slotTime);
      }
    }
    dayCursor.setUTCDate(dayCursor.getUTCDate() + 1);
  }

  slots.sort((a, b) => a - b);
  return slots;
}

// Generates batch sizes that stay in a tight band just above the
// minimum (e.g. min=50 -> sizes roughly 50-70), no matter how large the
// total quantity is. Large orders get MORE batches, not bigger ones -
// unlike the old approach where batch count was capped and size grew
// to absorb whatever was left over.
function randomizeNarrowBandSizes(quantity, effectiveMin, bandWidth) {
  const sizes = [];
  let remaining = quantity;

  while (remaining > effectiveMin + bandWidth) {
    const size = randomInt(effectiveMin, effectiveMin + bandWidth);
    sizes.push(size);
    remaining -= size;
  }

  if (remaining < effectiveMin && sizes.length > 0) {
    // Leftover is too small to stand as its own batch - fold it into
    // the last one rather than creating an under-minimum final batch.
    sizes[sizes.length - 1] += remaining;
  } else {
    sizes.push(remaining);
  }

  return sizes;
}

// Builds one Date per batch from the schedule's available slots.
//
// When batchCount fits within the available slots, picks an
// EVENLY-SPACED subset across the whole slot list - this is what makes
// a multi-day order actually deliver across every day of its window
// instead of front-loading onto the earliest slots.
//
// When batchCount exceeds available slots (narrow-band sizing on a
// large order needs more batches than there are real time slots), every
// slot gets used a full extra time before any slot gets reused twice,
// and any leftover partial reuse is itself spread evenly rather than
// biased toward the start. Every reuse beyond the first pass gets a
// small jitter (+/- 6 min) so repeat batches at "the same" scheduled
// moment don't carry an identical timestamp.
function buildRepeatingScheduleTimes(allSlots, count) {
  const n = allSlots.length;
  const fullCycles = Math.floor(count / n);
  const remainder = count % n;
  const times = [];

  for (let cycle = 0; cycle < fullCycles; cycle++) {
    for (let idx = 0; idx < n; idx++) {
      const jitter = cycle === 0 ? 0 : randomInt(-6, 6);
      times.push(new Date(allSlots[idx].getTime() + jitter * 60000));
    }
  }

  if (remainder > 0) {
    const step = n / remainder;
    for (let i = 0; i < remainder; i++) {
      const idx = Math.min(n - 1, Math.floor(i * step));
      const jitter = fullCycles === 0 ? 0 : randomInt(-6, 6);
      times.push(new Date(allSlots[idx].getTime() + jitter * 60000));
    }
  }

  times.sort((a, b) => a - b);
  return times;
}

// Maps an order's quantity onto its assigned fixed schedule using tight,
// minimum-hugging batch sizes. Batch count grows with quantity instead
// of batch size growing - the schedule's slots get reused (with jitter)
// as many times per day as needed to place every batch.
function planScheduleBatches(scheduleIndex, quantity, effectiveMin, windowMs, offsetMs) {
  const startDate = new Date(Date.now() + offsetMs);
  const allSlots = buildScheduleSlots(scheduleIndex, startDate, windowMs);

  if (allSlots.length === 0) {
    // Window too short to contain even one scheduled slot - deliver
    // everything right at the window start rather than failing the order.
    return { batchSizes: [quantity], scheduleTimes: [startDate] };
  }

  const bandWidth = Math.max(10, Math.round(effectiveMin * 0.4)); // e.g. min=50 -> band=20 (50-70)
  const batchSizes = randomizeNarrowBandSizes(quantity, effectiveMin, bandWidth);
  const scheduleTimes = buildRepeatingScheduleTimes(allSlots, batchSizes.length);

  return { batchSizes, scheduleTimes };
}

// Dual-provider version: each batch independently rolls a provider
// (respecting canUseThekclaut) and is sized in a tight band above
// *that* provider's own minimum, so a Betalogs batch looks like
// 50-70 and a TheKclaut batch looks like 100-140, never mixed up.
//
// If the whole order's quantity can't cover one TheKclaut-minimum
// batch, TheKclaut is excluded entirely for that order.
function planDualProviderScheduleBatches(scheduleIndex, quantity, betalogsMin, thekclautMin, windowMs, offsetMs) {
  const startDate = new Date(Date.now() + offsetMs);
  const allSlots = buildScheduleSlots(scheduleIndex, startDate, windowMs);
  const canUseThekclaut = quantity >= thekclautMin;

  if (allSlots.length === 0) {
    const provider = canUseThekclaut && Math.random() < 0.5 ? "thekclaut" : "betalogs";
    return { batchSizes: [quantity], scheduleTimes: [startDate], batchProviders: [provider] };
  }

  const batchSizes = [];
  const batchProviders = [];
  let remaining = quantity;

  while (remaining > 0) {
    const providerCandidate = canUseThekclaut && Math.random() < 0.5 ? "thekclaut" : "betalogs";
    const thisMin = providerCandidate === "thekclaut" ? thekclautMin : betalogsMin;
    const bandWidth = Math.max(10, Math.round(thisMin * 0.4));

    if (remaining <= thisMin + bandWidth) {
      if (remaining < thisMin) {
        // Too small to stand alone - fold into the previous batch
        // (whatever provider it already belongs to) rather than
        // creating a batch below its provider's minimum.
        if (batchSizes.length > 0) {
          batchSizes[batchSizes.length - 1] += remaining;
        } else {
          batchSizes.push(remaining);
          batchProviders.push("betalogs");
        }
      } else {
        batchSizes.push(remaining);
        batchProviders.push(providerCandidate);
      }
      break;
    }

    const size = randomInt(thisMin, thisMin + bandWidth);
    batchSizes.push(size);
    batchProviders.push(providerCandidate);
    remaining -= size;
  }

  const scheduleTimes = buildRepeatingScheduleTimes(allSlots, batchSizes.length);
  return { batchSizes, scheduleTimes, batchProviders };
}

// ==================================================================
// Scheduled batch processing
// ==================================================================
async function processDueBatches(env, force = false) {
  const currentWATHour = watHourOf(new Date());
  const isQuietHours = currentWATHour >= QUIET_HOUR_START_WAT && currentWATHour < QUIET_HOUR_END_WAT;

  // During quiet hours, don't go fully silent - just taper down hard.
  // Real activity slows at night, it doesn't flatline to exactly zero,
  // and a total blackout every single night is itself a giveaway.
  if (!force && isQuietHours && Math.random() < 0.7) {
    console.log("Quiet hours - tapered down, skipping this run.");
    return { skipped: "quiet_hours_taper" };
  }

  const processLimit = !force && isQuietHours ? 1 : BATCH_PROCESS_LIMIT;
  const accessToken = await getFirestoreAccessToken(env);
  const dueBatches = await firestoreQueryDueBatches(env, accessToken, processLimit);

  if (!dueBatches.length) {
    console.log("No due batches this run.");
    return { processed: 0, message: "No due batches found." };
  }

  const results = [];
  for (const batch of dueBatches) {
    try {
      // Don't fire exactly on the 10-minute clock mark every time -
      // a small random delay before each call breaks that machine-precise
      // pattern without meaningfully affecting delivery speed.
      const jitterMs = randomInt(0, 25000);
      await new Promise((resolve) => setTimeout(resolve, jitterMs));

      let data;
      if (batch.fields.provider === "thekclaut") {
        data = await callTheKclaut(env, "add", {
          service: String(batch.fields.serviceId),
          link: batch.fields.link,
          quantity: String(batch.fields.quantity),
        });
        if (data.error) throw new Error(data.error);
      } else {
        const params = new URLSearchParams({
          key: env.BETALOGS_API_KEY,
          action: "add",
          service: String(batch.fields.serviceId),
          link: batch.fields.link,
          quantity: String(batch.fields.quantity),
        });
        const res = await fetch(`${BETALOGS_API_URL}?${params.toString()}`);
        data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      }

      await firestorePatchByPath(env, accessToken, batch.name, {
        status: "sent",
        betalogsOrderId: data.order || null,
        sentAt: new Date().toISOString(),
      });

      const orderPath = `orders/${batch.fields.orderId}`;
      const order = await firestoreGet(env, accessToken, orderPath);
      if (order) {
        const deliveredBatches = (order.deliveredBatches || 0) + 1;
        const deliveredQuantity = (order.deliveredQuantity || 0) + batch.fields.quantity;
        const isDone = deliveredBatches >= (order.totalBatches || 1);
        await firestorePatch(env, accessToken, orderPath, {
          deliveredBatches,
          deliveredQuantity,
          status: isDone ? "completed" : "processing",
        });
      }
      results.push({ batch: batch.name, status: "sent" });
    } catch (err) {
      console.error(`Batch ${batch.name} failed:`, err.message);
      await firestorePatchByPath(env, accessToken, batch.name, {
        status: "failed",
        failureReason: err.message || "Unknown error",
      });
      results.push({ batch: batch.name, status: "failed", error: err.message });
    }
  }

  return { processed: results.length, results };
}

// ==================================================================
// Firebase ID token verification (no Firebase Admin SDK available here)
// ==================================================================
let cachedJWKS = null;
let cachedJWKSAt = 0;

async function getGoogleJWKS() {
  if (cachedJWKS && Date.now() - cachedJWKSAt < 3600 * 1000) return cachedJWKS;
  const res = await fetch(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
  );
  const data = await res.json();
  cachedJWKS = data.keys;
  cachedJWKSAt = Date.now();
  return cachedJWKS;
}

function base64urlToUint8Array(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64urlDecodeJSON(str) {
  return JSON.parse(new TextDecoder().decode(base64urlToUint8Array(str)));
}

async function verifyFirebaseIdToken(idToken, projectId) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");

  const header = base64urlDecodeJSON(parts[0]);
  const payload = base64urlDecodeJSON(parts[1]);
  const signature = base64urlToUint8Array(parts[2]);
  const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);

  const jwks = await getGoogleJWKS();
  const jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("No matching signing key found");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signedData);
  if (!valid) throw new Error("Invalid token signature");

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error("Token expired");
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("Invalid issuer");
  if (payload.aud !== projectId) throw new Error("Invalid audience");
  if (!payload.sub) throw new Error("Missing subject");

  return payload;
}

// ==================================================================
// Firestore REST access via a service account (Web Crypto JWT signing)
// ==================================================================
let cachedAccessToken = null;
let cachedAccessTokenExp = 0;

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64urlEncode(bufferOrString) {
  let bytes;
  if (typeof bufferOrString === "string") {
    bytes = new TextEncoder().encode(bufferOrString);
  } else {
    bytes = new Uint8Array(bufferOrString);
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getFirestoreAccessToken(env) {
  if (cachedAccessToken && Date.now() / 1000 < cachedAccessTokenExp - 60) {
    return cachedAccessToken;
  }

  const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const unsignedToken = `${base64urlEncode(JSON.stringify(header))}.${base64urlEncode(
    JSON.stringify(claimSet)
  )}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(serviceAccount.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedToken)
  );

  const jwt = `${unsignedToken}.${base64urlEncode(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error("Failed to get Firestore access token");

  cachedAccessToken = data.access_token;
  cachedAccessTokenExp = now + (data.expires_in || 3600);
  return cachedAccessToken;
}

function firestoreValueToJS(fields) {
  const out = {};
  for (const [key, val] of Object.entries(fields || {})) {
    if ("stringValue" in val) out[key] = val.stringValue;
    else if ("integerValue" in val) out[key] = parseInt(val.integerValue, 10);
    else if ("doubleValue" in val) out[key] = val.doubleValue;
    else if ("booleanValue" in val) out[key] = val.booleanValue;
    else if ("nullValue" in val) out[key] = null;
    else if ("timestampValue" in val) out[key] = val.timestampValue;
    else out[key] = val;
  }
  return out;
}

function jsToFirestoreFields(obj) {
  const fields = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) fields[key] = { nullValue: null };
    else if (typeof val === "number") {
      fields[key] = Number.isInteger(val) ? { integerValue: val } : { doubleValue: val };
    } else if (typeof val === "boolean") fields[key] = { booleanValue: val };
    else fields[key] = { stringValue: String(val) };
  }
  return fields;
}

async function firestoreGet(env, accessToken, path) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 404) return null;
  const data = await res.json();
  if (!data.fields) return null;
  return firestoreValueToJS(data.fields);
}

async function firestoreCreate(env, accessToken, collectionPath, obj) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collectionPath}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: jsToFirestoreFields(obj) }),
  });
  return res.json();
}

async function firestorePatch(env, accessToken, path, obj) {
  const fieldNames = Object.keys(obj);
  const maskParams = fieldNames.map((f) => `updateMask.fieldPaths=${f}`).join("&");
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}?${maskParams}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: jsToFirestoreFields(obj) }),
  });
  return res.json();
}

async function firestorePatchByPath(env, accessToken, fullResourceName, obj) {
  const fieldNames = Object.keys(obj);
  const maskParams = fieldNames.map((f) => `updateMask.fieldPaths=${f}`).join("&");
  const base = fullResourceName.split("/documents/")[1];
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${base}?${maskParams}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: jsToFirestoreFields(obj) }),
  });
  return res.json();
}

// Updates the "status" field on many documents in as few HTTP requests as
// possible, using Firestore's :commit endpoint (single request can carry
// hundreds of writes). This avoids hitting Cloudflare's per-invocation
// subrequest limit on orders with a large number of batches.
async function firestoreBatchUpdateStatus(env, accessToken, docs, newStatus) {
  if (!docs.length) return 0;

  const CHUNK_SIZE = 400;
  let updatedCount = 0;

  for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
    const chunk = docs.slice(i, i + CHUNK_SIZE);
    const writes = chunk.map((doc) => ({
      update: {
        name: doc.name,
        fields: jsToFirestoreFields({ status: newStatus }),
      },
      updateMask: { fieldPaths: ["status"] },
    }));

    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:commit`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ writes }),
    });

    if (res.ok) updatedCount += chunk.length;
  }

  return updatedCount;
}

// Queries across ALL "batches" subcollections (collection group query)
// for ones that are pending and due, oldest first, capped at the
// two-at-a-time processing limit.
async function firestoreQueryDueBatches(env, accessToken, limit = BATCH_PROCESS_LIMIT) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const nowISO = new Date().toISOString();

  const body = {
    structuredQuery: {
      from: [{ collectionId: "batches", allDescendants: true }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "pending" } } },
            { fieldFilter: { field: { fieldPath: "scheduledAt" }, op: "LESS_THAN_OR_EQUAL", value: { stringValue: nowISO } } },
          ],
        },
      },
      orderBy: [{ field: { fieldPath: "scheduledAt" }, direction: "ASCENDING" }],
      limit: limit,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const results = await res.json();

  if (!Array.isArray(results)) {
    throw new Error("Firestore query error: " + JSON.stringify(results));
  }

  return results
    .filter((r) => r.document)
    .map((r) => ({ name: r.document.name, fields: firestoreValueToJS(r.document.fields) }));
}

// ==================================================================
// Small helpers
// ==================================================================
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function corsResponse(env, response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN || "*");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(response.body, { status: response.status, headers });
}
