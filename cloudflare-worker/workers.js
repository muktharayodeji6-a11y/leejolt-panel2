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

// In-memory cache for the Betalogs service list (per Worker isolate)
let cachedServices = null;
let cachedServicesAt = 0;
const SERVICES_CACHE_MS = 10 * 60 * 1000; // 10 minutes

// ---- Human-Mimicking Drip-feed configuration ----
const QUIET_HOUR_START_WAT = 0;   // 12am
const QUIET_HOUR_END_WAT = 6;     // 6am
const DELIVERY_WINDOW_HOURS = 24;   // fallback default if no deadline given
const MIN_WINDOW_MINUTES = 15;      // deadline can't be sooner than this
const MAX_WINDOW_DAYS = 14;         // deadline can't be further than this

// Human-like batch parameters - highly variable
const BATCH_MIN = 1;    // Can be tiny (human might do small batches)
const BATCH_MAX = 45;   // Natural maximum for human activity
const BATCH_PROCESS_LIMIT = 1; // Humans do one thing at a time

// Peak hours (when humans are most active)
const PEAK_HOURS_WAT = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];

// Human activity patterns with natural variability
const HUMAN_PATTERNS = {
  // Morning person (early bird)
  early_bird: {
    peak_start: 7, peak_end: 14,
    activity_level: 0.85,
    break_frequency: 0.15
  },
  // Night owl
  night_owl: {
    peak_start: 14, peak_end: 23,
    activity_level: 0.80,
    break_frequency: 0.20
  },
  // Balanced (most common)
  balanced: {
    peak_start: 9, peak_end: 18,
    activity_level: 0.70,
    break_frequency: 0.25
  },
  // Erratic (unpredictable)
  erratic: {
    peak_start: 10, peak_end: 20,
    activity_level: 0.60,
    break_frequency: 0.35
  }
};

// Per-service overrides for the drip-feed batch floor
const SERVICE_MIN_OVERRIDES = { "2479": 20 }; // Views

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
      const { orderId, serviceId, link, quantity, completeBy, startOffsetMinutes, serviceMin } = body;

      if (!orderId || !serviceId || !link || !quantity) {
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

      // Generate human-like batch plan
      const batchSizes = generateHumanBatchPlan(quantity, serviceMin, serviceId);
      // Generate human-like schedule
      const scheduleTimes = assignHumanScheduleTimes(batchSizes.length, remainingWindowMs, offsetMs);

      // Create batches with human-like metadata
      for (let i = 0; i < batchSizes.length; i++) {
        await firestoreCreate(env, accessToken, `orders/${orderId}/batches`, {
          orderId,
          serviceId,
          link,
          quantity: batchSizes[i],
          scheduledAt: scheduleTimes[i].toISOString(),
          status: "pending",
          createdAt: new Date().toISOString(),
          // Human-like metadata (subtle, for natural appearance)
          batchNumber: i + 1,
          totalBatches: batchSizes.length
        });
      }

      await firestorePatch(env, accessToken, `orders/${orderId}`, {
        status: "processing",
        totalBatches: batchSizes.length,
        deliveredBatches: 0,
        deliveredQuantity: 0,
        // Store human pattern used for this order
        humanPattern: determineHumanPattern()
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

// ==================================================================
// Human Behavior Detection & Simulation
// ==================================================================

function determineHumanPattern() {
  const patterns = Object.keys(HUMAN_PATTERNS);
  // Weighted random: most people are balanced
  const weights = [0.15, 0.15, 0.55, 0.15]; // early_bird, night_owl, balanced, erratic
  let total = weights.reduce((a, b) => a + b, 0);
  let random = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    random -= weights[i];
    if (random <= 0) return patterns[i];
  }
  return "balanced";
}

function getHumanPattern(patternName) {
  return HUMAN_PATTERNS[patternName] || HUMAN_PATTERNS.balanced;
}

function isHumanActive(currentTime, patternName = "balanced") {
  const pattern = getHumanPattern(patternName);
  const hour = currentTime.getHours();
  const minute = currentTime.getMinutes();
  const timeOfDay = hour + minute / 60;
  
  // Check if within peak hours
  const isPeak = timeOfDay >= pattern.peak_start && timeOfDay <= pattern.peak_end;
  
  // Base activity probability
  let activityProb = isPeak ? pattern.activity_level : pattern.activity_level * 0.6;
  
  // Add random variation (human mood)
  const moodVariation = (Math.random() - 0.5) * 0.2;
  activityProb = Math.max(0.1, Math.min(0.95, activityProb + moodVariation));
  
  // Check quiet hours (night)
  if (hour >= QUIET_HOUR_START_WAT && hour < QUIET_HOUR_END_WAT) {
    activityProb *= 0.2; // Drastically reduced activity at night
  }
  
  // Random burst activity (humans are unpredictable)
  if (Math.random() < 0.1) {
    activityProb = Math.min(0.9, activityProb + 0.3);
  }
  
  return Math.random() < activityProb;
}

// ==================================================================
// Human-like Batch Planning
// ==================================================================

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function generateHumanBatchPlan(totalQuantity, serviceMin, serviceId) {
  const overrideMin = SERVICE_MIN_OVERRIDES[String(serviceId)];
  const effectiveMin = Math.max(1, overrideMin || serviceMin || BATCH_MIN);
  
  // Human-like: some days are productive, some are lazy
  const productivity = randomFloat(0.6, 1.4);
  const effectiveMax = Math.min(
    BATCH_MAX,
    Math.max(effectiveMin * 2, Math.ceil(effectiveMin * 1.5 * productivity))
  );
  
  // Calculate possible batches
  const maxPossibleBatches = Math.floor(totalQuantity / effectiveMin);
  
  if (maxPossibleBatches <= 1) {
    return [totalQuantity];
  }
  
  // Human-like batch count: not always optimal
  let batchCount;
  const rand = Math.random();
  if (rand < 0.25) {
    // Lazy human: fewer batches
    batchCount = Math.max(1, Math.floor(maxPossibleBatches * randomFloat(0.2, 0.4)));
  } else if (rand < 0.6) {
    // Normal human: moderate batches
    batchCount = Math.max(1, Math.floor(maxPossibleBatches * randomFloat(0.4, 0.7)));
  } else if (rand < 0.85) {
    // Productive human: many batches
    batchCount = Math.max(1, Math.floor(maxPossibleBatches * randomFloat(0.7, 0.95)));
  } else {
    // Erratic human: weird number
    batchCount = Math.max(1, Math.floor(maxPossibleBatches * randomFloat(0.3, 0.9)));
  }
  
  // Ensure we don't have too many tiny batches
  batchCount = Math.min(batchCount, Math.floor(totalQuantity / effectiveMin));
  
  const batches = [];
  let remaining = totalQuantity;
  
  // Human-like batch size distribution with natural clusters
  for (let i = 0; i < batchCount; i++) {
    const batchesLeft = batchCount - i;
    if (batchesLeft === 1) {
      batches.push(remaining);
      break;
    }
    
    const avgRemaining = remaining / batchesLeft;
    
    // Human behavior patterns in batch sizes
    let size;
    const position = i / batchCount; // Position in sequence (0 to 1)
    
    if (position < 0.2) {
      // Starting strong (human enthusiasm)
      size = avgRemaining * randomFloat(1.0, 1.6);
    } else if (position < 0.4) {
      // Middle: variable
      if (Math.random() < 0.3) {
        size = avgRemaining * randomFloat(0.4, 0.7); // Small batch (distraction)
      } else {
        size = avgRemaining * randomFloat(0.8, 1.3);
      }
    } else if (position < 0.7) {
      // Steady work
      size = avgRemaining * randomFloat(0.7, 1.2);
    } else {
      // Tapering off (fatigue)
      size = avgRemaining * randomFloat(0.5, 0.9);
    }
    
    // Apply limits
    size = Math.max(effectiveMin, Math.min(effectiveMax * 1.2, size));
    
    // Ensure we don't leave too little for remaining batches
    const minNeededForRest = effectiveMin * (batchesLeft - 1);
    if (remaining - size < minNeededForRest) {
      size = remaining - minNeededForRest;
    }
    size = Math.max(effectiveMin, Math.min(effectiveMax, Math.round(size)));
    
    batches.push(size);
    remaining -= size;
  }
  
  // Add some random variation to make it look more natural
  const finalBatches = [];
  let adjustedRemaining = totalQuantity;
  for (let i = 0; i < batches.length - 1; i++) {
    let adjusted = batches[i] + randomInt(-Math.max(2, batches[i] * 0.05), Math.max(2, batches[i] * 0.05));
    adjusted = Math.max(effectiveMin, Math.min(effectiveMax, adjusted));
    adjustedRemaining -= adjusted;
    finalBatches.push(adjusted);
  }
  finalBatches.push(adjustedRemaining);
  
  return finalBatches;
}

// ==================================================================
// Human-like Schedule Timing
// ==================================================================

function watHourOf(date) {
  return (date.getUTCHours() + 1) % 24;
}

function isQuietHour(date) {
  const hour = watHourOf(date);
  return hour >= QUIET_HOUR_START_WAT && hour < QUIET_HOUR_END_WAT;
}

function isPeakHour(date, patternName = "balanced") {
  const pattern = getHumanPattern(patternName);
  const hour = watHourOf(date);
  return hour >= pattern.peak_start && hour <= pattern.peak_end;
}

function assignHumanScheduleTimes(count, windowMs, startOffsetMs = 0) {
  const now = Date.now() + startOffsetMs;
  const times = [];
  const patternName = determineHumanPattern();
  const pattern = getHumanPattern(patternName);
  
  // Human-like scheduling patterns
  const scheduleStyles = [
    // Front-loaded (enthusiastic start)
    { surge: 1.8, taper: 0.5, weight: 0.25 },
    // Even spread (methodical)
    { surge: 1.0, taper: 1.0, weight: 0.20 },
    // Back-loaded (procrastinator)
    { surge: 0.5, taper: 1.8, weight: 0.15 },
    // Burst pattern (works in sprints)
    { surge: 1.3, taper: 0.7, weight: 0.25 },
    // Erratic (unpredictable)
    { surge: 1.5, taper: 0.5, weight: 0.15 }
  ];
  
  // Pick a style based on "human mood"
  let totalWeight = scheduleStyles.reduce((sum, s) => sum + s.weight, 0);
  let rand = Math.ran
