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

// ==================================================================
// CONFIGURATION - All scheduler settings in one place
// ==================================================================
const SCHEDULER_CONFIG = {
  // Service-specific rules
  serviceRules: {
    "Views": {
      minBatch: 50,
      maxBatch: 200,
      priority: 1,
      deliveryWindowHours: 24,
      peakMultiplier: 1.0
    },
    "Likes": {
      minBatch: 20,
      maxBatch: 150,
      priority: 2,
      deliveryWindowHours: 48,
      peakMultiplier: 1.3
    },
    "Shares": {
      minBatch: 10,
      maxBatch: 80,
      priority: 3,
      deliveryWindowHours: 72,
      peakMultiplier: 1.5
    },
    "Saves": {
      minBatch: 10,
      maxBatch: 60,
      priority: 2,
      deliveryWindowHours: 48,
      peakMultiplier: 1.2
    },
    "Comments": {
      minBatch: 5,
      maxBatch: 40,
      priority: 4,
      deliveryWindowHours: 96,
      peakMultiplier: 1.8
    },
    "Reposts": {
      minBatch: 10,
      maxBatch: 50,
      priority: 3,
      deliveryWindowHours: 72,
      peakMultiplier: 1.4
    },
    "Followers": {
      minBatch: 10,
      maxBatch: 100,
      priority: 1,
      deliveryWindowHours: 24,
      peakMultiplier: 1.1
    }
  },
  
  // Global scheduler settings
  global: {
    quietHourStart: 0,      // 12am WAT
    quietHourEnd: 6,        // 6am WAT
    peakHours: [8, 9, 10, 12, 13, 17, 18, 19, 20, 21, 22],
    defaultWindowHours: 24,
    minWindowMinutes: 15,
    maxWindowDays: 14,
    maxBatchesPerOrder: 400,
    batchProcessLimit: 3,
    retryLimit: 3,
    retryDelayMinutes: 5,
    serviceCacheMs: 10 * 60 * 1000,
    driftMinutes: 30,
    minGapSeconds: 60,
    maxGapSeconds: 300
  }
};

// ==================================================================
// Entry points
// ==================================================================
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return corsResponse(env, new Response(null, { status: 204 }));
    }

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
          return fields.status === "pending" || fields.status === "failed";
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

      // Get service-specific rules
      const serviceRule = SCHEDULER_CONFIG.serviceRules[serviceId] || {
        minBatch: 50,
        maxBatch: 200,
        priority: 1,
        deliveryWindowHours: SCHEDULER_CONFIG.global.defaultWindowHours,
        peakMultiplier: 1.0
      };

      // Calculate delivery window
      let windowMs = serviceRule.deliveryWindowHours * 3600 * 1000;
      if (completeBy) {
        const deadlineMs = new Date(completeBy).getTime() - Date.now();
        if (isNaN(deadlineMs)) {
          return corsResponse(env, jsonResponse({ error: "Invalid deadline" }, 400));
        }
        const minMs = SCHEDULER_CONFIG.global.minWindowMinutes * 60 * 1000;
        const maxMs = SCHEDULER_CONFIG.global.maxWindowDays * 24 * 3600 * 1000;
        if (deadlineMs < minMs) {
          return corsResponse(env, jsonResponse({ error: `Deadline must be at least ${SCHEDULER_CONFIG.global.minWindowMinutes} minutes from now` }, 400));
        }
        windowMs = Math.min(deadlineMs, maxMs);
      }

      // Apply start offset for multi-service staggering
      const offsetMs = Math.max(0, (startOffsetMinutes || 0) * 60 * 1000);
      const remainingWindowMs = windowMs - offsetMs;
      if (remainingWindowMs < SCHEDULER_CONFIG.global.minWindowMinutes * 60 * 1000) {
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

      const effectiveMin = Math.max(Math.floor(Number(serviceMin)) || 0, serviceRule.minBatch);
      const batchSizes = generateBatchPlan(quantity, effectiveMin, serviceRule.maxBatch);
      const scheduleTimes = assignScheduleTimes(
        batchSizes.length, 
        remainingWindowMs, 
        offsetMs,
        serviceRule.priority,
        SCHEDULER_CONFIG.global
      );

      const nowISO = new Date().toISOString();
      const batchDocs = batchSizes.map((size, i) => ({
        orderId,
        serviceId,
        link,
        quantity: size,
        scheduledAt: scheduleTimes[i].toISOString(),
        status: "pending",
        createdAt: nowISO,
        retryCount: 0,
        priority: serviceRule.priority
      }));

      await firestoreBatchCreate(env, accessToken, `orders/${orderId}/batches`, batchDocs);

      await firestorePatch(env, accessToken, `orders/${orderId}`, {
        status: "processing",
        totalBatches: batchSizes.length,
        deliveredBatches: 0,
        deliveredQuantity: 0,
        servicePriority: serviceRule.priority
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
  const cacheMs = SCHEDULER_CONFIG.global.serviceCacheMs;
  if (cachedServices && Date.now() - cachedServicesAt < cacheMs) {
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
// Drip-feed batch planning - Improved version
// ==================================================================
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Deterministic pseudo-random number generator for a given seed
function seededRandom(seed) {
  return function() {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
}

function generateBatchPlan(totalQuantity, minBatch, maxBatch) {
  // Validate inputs
  if (!Number.isFinite(totalQuantity) || totalQuantity <= 0) {
    return [0];
  }
  
  if (totalQuantity <= minBatch) {
    return [totalQuantity];
  }

  // Use a deterministic seed based on totalQuantity and minBatch for reproducibility
  const seed = (totalQuantity * 7919 + minBatch * 6271) % 100000;
  const rand = seededRandom(seed);

  // Determine optimal batch count based on quantity and limits
  let targetBatchSize = minBatch + (maxBatch - minBatch) * (0.3 + rand() * 0.5);
  let batchCount = Math.round(totalQuantity / targetBatchSize);
  
  const maxBatches = Math.min(
    Math.floor(totalQuantity / minBatch),
    SCHEDULER_CONFIG.global.maxBatchesPerOrder
  );
  batchCount = Math.max(1, Math.min(batchCount, maxBatches));

  if (batchCount <= 1) {
    return [totalQuantity];
  }

  // Generate batch sizes with natural variation
  let sizes = [];
  let remaining = totalQuantity;
  
  for (let i = 0; i < batchCount - 1; i++) {
    // Vary batch sizes: some small, some medium, occasional large
    let sizeFactor;
    const roll = rand();
    if (roll < 0.4) {
      // Small batch
      sizeFactor = 0.5 + rand() * 0.3;
    } else if (roll < 0.75) {
      // Medium batch
      sizeFactor = 0.8 + rand() * 0.4;
    } else if (roll < 0.92) {
      // Large batch
      sizeFactor = 1.2 + rand() * 0.5;
    } else {
      // Extra large burst
      sizeFactor = 1.7 + rand() * 0.8;
    }
    
    const maxPossible = Math.floor(remaining / (batchCount - i));
    let size = Math.round((totalQuantity / batchCount) * sizeFactor);
    size = Math.max(minBatch, Math.min(size, maxPossible));
    size = Math.min(size, remaining - (batchCount - i - 1) * minBatch);
    size = Math.min(size, maxBatch);
    size = Math.max(minBatch, size);
    
    sizes.push(size);
    remaining -= size;
  }
  
  // Last batch gets whatever remains
  sizes.push(Math.max(minBatch, remaining));

  // Adjust to ensure total equals original quantity
  let sum = sizes.reduce((a, b) => a + b, 0);
  if (sum !== totalQuantity) {
    const diff = totalQuantity - sum;
    // Distribute difference to batches that can absorb it
    for (let i = 0; i < sizes.length && diff !== 0; i++) {
      if (diff > 0 && sizes[i] < maxBatch) {
        const add = Math.min(diff, maxBatch - sizes[i]);
        sizes[i] += add;
        diff -= add;
      } else if (diff < 0 && sizes[i] > minBatch) {
        const sub = Math.min(-diff, sizes[i] - minBatch);
        sizes[i] -= sub;
        diff += sub;
      }
    }
  }

  // Shuffle to avoid size correlation with order
  for (let i = sizes.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [sizes[i], sizes[j]] = [sizes[j], sizes[i]];
  }

  return sizes;
}

function watHourOf(date) {
  return (date.getUTCHours() + 1) % 24;
}

function isPeakHour(hour, peakHours) {
  return peakHours.includes(hour);
}

function softHumanizeHour(date, windowStart, windowEnd, config) {
  const hour = watHourOf(date);
  const target = new Date(date.getTime());
  
  // Check quiet hours
  const inQuiet = hour >= config.quietHourStart && hour < config.quietHourEnd;
  if (inQuiet) {
    // Move to after quiet hours
    const hoursToAdd = config.quietHourEnd - hour + (Math.random() * 2);
    target.setUTCHours(target.getUTCHours() + hoursToAdd);
  } else if (!isPeakHour(hour, config.peakHours) && Math.random() < 0.35) {
    // Occasionally nudge toward peak hours
    const targetHour = config.peakHours[Math.floor(Math.random() * config.peakHours.length)];
    let hourDiff = targetHour - hour;
    if (hourDiff > 12) hourDiff -= 24;
    if (hourDiff < -12) hourDiff += 24;
    target.setUTCHours(target.getUTCHours() + hourDiff * 0.5);
  }

  const t = target.getTime();
  if (t < windowStart || t > windowEnd) return date;
  return target;
}

function assignScheduleTimes(count, windowMs, startOffsetMs, priority, config) {
  const windowStart = Date.now() + startOffsetMs;
  const windowEnd = windowStart + Math.max(0, windowMs);

  if (count <= 0) return [];
  if (count === 1) {
    const midPoint = windowStart + windowMs * 0.5;
    const variance = windowMs * 0.3;
    let t = new Date(midPoint + (Math.random() - 0.5) * variance * 2);
    t = new Date(Math.max(windowStart, Math.min(windowEnd, t.getTime())));
    if (windowMs > 20 * 3600 * 1000) {
      t = softHumanizeHour(t, windowStart, windowEnd, config);
    }
    return [t];
  }

  // Generate positions with natural clustering
  const positions = [];
  const clusterCount = Math.max(2, Math.round(count / (2 + Math.random() * 3)));
  const clusterCenters = [];
  
  for (let i = 0; i < clusterCount; i++) {
    clusterCenters.push(Math.random());
  }
  clusterCenters.sort((a, b) => a - b);

  // Higher priority services (lower number) get more even distribution
  const priorityFactor = Math.max(0.5, Math.min(2.0, 2.0 / (priority + 0.5)));
  
  for (let i = 0; i < count; i++) {
    let pos;
    if (Math.random() < 0.15 * priorityFactor) {
      // Isolated events
      pos = Math.random();
    } else {
      const center = clusterCenters[Math.floor(Math.random() * clusterCenters.length)];
      const spread = (0.02 + Math.random() * 0.1) * priorityFactor;
      const gauss = ((Math.random() + Math.random() + Math.random()) / 3 - 0.5) * 2;
      pos = center + gauss * spread;
    }
    positions.push(Math.max(0.001, Math.min(0.999, pos)));
  }
  positions.sort((a, b) => a - b);

  // Spread across the window more naturally
  const earlyAnchor = 0.02 + Math.random() * 0.06;
  const lateAnchor = 0.94 + Math.random() * 0.04;
  const minPos = positions[0];
  const maxPos = positions[positions.length - 1];
  
  let adjustedPositions;
  if (maxPos > minPos) {
    const scale = (lateAnchor - earlyAnchor) / (maxPos - minPos);
    adjustedPositions = positions.map(p => earlyAnchor + (p - minPos) * scale);
  } else {
    adjustedPositions = positions.map((_, i) => {
      const progress = i / (count - 1);
      return earlyAnchor + (lateAnchor - earlyAnchor) * progress;
    });
  }

  // Add some jitter to make it less regular
  const jitterAmount = 0.02 + Math.random() * 0.03;
  adjustedPositions = adjustedPositions.map(p => {
    const jitter = (Math.random() - 0.5) * jitterAmount;
   
