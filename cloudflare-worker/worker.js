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

// ---- Drip-feed configuration ----
const QUIET_HOUR_START_WAT = 0;   // 12am
const QUIET_HOUR_END_WAT = 6;     // 6am
const DELIVERY_WINDOW_HOURS = 24;   // fallback default if no deadline given
const MIN_WINDOW_MINUTES = 15;      // deadline can't be sooner than this
const MAX_WINDOW_DAYS = 14;         // deadline can't be further than this
const BATCH_MIN = 20;
const BATCH_MAX = 60;
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

    // GET ?type=balance = your Betalogs provider balance (requires sign-in).
    // GET (no params) = public service list, no auth needed.
    if (request.method === "GET") {
      const url = new URL(request.url);

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
      const { orderId, serviceId, link, quantity, completeBy, startOffsetMinutes } = body;

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

      const batchSizes = generateBatchPlan(quantity);
      const scheduleTimes = assignScheduleTimes(batchSizes.length, remainingWindowMs, offsetMs);

      for (let i = 0; i < batchSizes.length; i++) {
        await firestoreCreate(env, accessToken, `orders/${orderId}/batches`, {
          orderId,
          serviceId,
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

function assignScheduleTimes(count, windowMs, startOffsetMs = 0) {
  const now = Date.now() + startOffsetMs;
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
async function processDueBatches(env, force = false) {
  const currentWATHour = watHourOf(new Date());
  if (!force && currentWATHour >= QUIET_HOUR_START_WAT && currentWATHour < QUIET_HOUR_END_WAT) {
    console.log("Quiet hours - skipping this run.");
    return { skipped: "quiet_hours" };
  }

  const accessToken = await getFirestoreAccessToken(env);
  const dueBatches = await firestoreQueryDueBatches(env, accessToken);

  if (!dueBatches.length) {
    console.log("No due batches this run.");
    return { processed: 0, message: "No due batches found." };
  }

  const results = [];
  for (const batch of dueBatches) {
    try {
      const params = new URLSearchParams({
        key: env.BETALOGS_API_KEY,
        action: "add",
        service: String(batch.fields.serviceId),
        link: batch.fields.link,
        quantity: String(batch.fields.quantity),
      });

      const res = await fetch(`${BETALOGS_API_URL}?${params.toString()}`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);

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

// Same as firestorePatch, but `fullPath` is already the full document
// resource name returned by a query (used for batch docs).
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

// Queries across ALL "batches" subcollections (collection group query)
// for ones that are pending and due, oldest first, capped at the
// two-at-a-time processing limit.
async function firestoreQueryDueBatches(env, accessToken) {
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
      limit: BATCH_PROCESS_LIMIT,
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

  return (results || [])
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
