// Ring helper for the iPhone dashboard.
// Runs on a home PC, signs in to Ring with a refresh token and serves
// camera snapshots to the dashboard. Settings come from .env (never committed).
//
//   GET  /health                     -> { ok: true, uptime }
//   GET  /ring/cameras               -> [{ id, name, offline, battery }]
//   GET  /ring/cameras/:id/snapshot  -> image/jpeg
//   GET  /push/key                   -> { publicKey }   (for the phone to subscribe)
//   POST /push/subscribe             <- the phone's push subscription
//   POST /push/watch                 <- { id, crs, station, std }: alert when it's 10 min away
//   POST /push/unwatch               stop watching
//   POST /push/test                  <- { delaySeconds }: send a test notification (optionally later)
//   GET  /sonos/rooms                -> [{ id, name, group, fadeLeft, volume, muted, playing }]
//   GET  /sonos/art/:id              -> artwork for what room id's group is playing
//   POST /sonos/volume               <- { id, volume }   (0 to 100)
//   POST /sonos/mute                 <- { id, muted }
//   POST /sonos/join                 <- { id, to }: room id plays along with room to's group
//   POST /sonos/leave                <- { id }: room id leaves its group
//   POST /sonos/fade                 fade out every playing room over 90 s, then pause
//   POST /sonos/fade/stop            stop fading (the volume stays where it is)
//
// Every request needs "Authorization: Bearer <DASHBOARD_TOKEN>".

import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { RingApi } from "ring-client-api";
import { addSubscription, notifyAll, phoneCount, publicKey, unwatchTrain, watchTrain } from "./notify.js";
import { sonosArt, sonosFade, sonosJoin, sonosLeave, sonosRooms, sonosSetMute, sonosSetVolume, sonosStopFade } from "./sonos.js";

const PORT = Number(process.env.PORT || 8787);
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://geedubyah2.github.io";
const SNAPSHOT_CACHE_SECONDS = Number(process.env.SNAPSHOT_CACHE_SECONDS || 30);
const TOKEN_FILE = new URL("./ring-token.json", import.meta.url);

if (DASHBOARD_TOKEN.length < 24) {
  console.error("Set DASHBOARD_TOKEN in .env to a long random string (24+ characters).");
  process.exit(1);
}

// Ring hands out a new refresh token from time to time; keep the latest one on disk.
function loadRefreshToken() {
  try { return JSON.parse(readFileSync(TOKEN_FILE, "utf8")).refreshToken; } catch { /* first run */ }
  return process.env.RING_REFRESH_TOKEN || "";
}

const refreshToken = loadRefreshToken();
if (!refreshToken) {
  console.error("No Ring refresh token. Run `npm run auth`, then put the token in .env as RING_REFRESH_TOKEN.");
  process.exit(1);
}

const ring = new RingApi({ refreshToken, controlCenterDisplayName: "dashboard-helper" });
ring.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
  writeFileSync(TOKEN_FILE, JSON.stringify({ refreshToken: newRefreshToken }));
});

let camerasPromise;
const getCameras = () => (camerasPromise ??= ring.getCameras().catch((e) => { camerasPromise = undefined; throw e; }));

// One snapshot request per camera at a time, reused for SNAPSHOT_CACHE_SECONDS.
const snapshots = new Map(); // id -> { at, promise }
function getSnapshot(camera) {
  const hit = snapshots.get(camera.id);
  if (hit && Date.now() - hit.at < SNAPSHOT_CACHE_SECONDS * 1000) return hit.promise;
  const promise = camera.getSnapshot();
  snapshots.set(camera.id, { at: Date.now(), promise });
  promise.catch(() => snapshots.delete(camera.id));
  return promise;
}

function authorised(req) {
  const given = Buffer.from((req.headers.authorization || "").replace(/^Bearer /, ""));
  const want = Buffer.from(DASHBOARD_TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

// Reads a small JSON request body (10 KB max).
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 10240) { reject(new Error("too large")); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return send(res, 204, "", "text/plain");
  if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { error: "method not allowed" });
  if (!authorised(req)) return send(res, 401, { error: "unauthorised" });

  const path = new URL(req.url, "http://x").pathname;

  if (req.method === "POST") {
    try {
      const body = await readJson(req);
      if (path === "/push/subscribe") { addSubscription(body); return send(res, 200, { ok: true }); }
      if (path === "/push/watch") { watchTrain(body); return send(res, 200, { ok: true }); }
      if (path === "/push/unwatch") { unwatchTrain(); return send(res, 200, { ok: true }); }
      if (path === "/push/test") {
        const message = { title: "Dashboard", body: "Test notification: alerts are working.", tag: "test" };
        const delay = Math.max(0, Math.min(60, Number(body.delaySeconds) || 0));
        if (delay) { // gives you time to lock the phone first
          setTimeout(() => notifyAll(message), delay * 1000);
          return send(res, 200, { ok: true, scheduled: delay, phones: phoneCount() });
        }
        const results = await notifyAll(message);
        return send(res, 200, { ok: results.some((s) => s >= 200 && s < 300), results });
      }
      if (path === "/sonos/volume") return send(res, 200, await sonosSetVolume(body.id, body.volume));
      if (path === "/sonos/mute") return send(res, 200, await sonosSetMute(body.id, body.muted));
      if (path === "/sonos/join") return send(res, 200, await sonosJoin(body.id, body.to));
      if (path === "/sonos/leave") return send(res, 200, await sonosLeave(body.id));
      if (path === "/sonos/fade") return send(res, 200, await sonosFade());
      if (path === "/sonos/fade/stop") return send(res, 200, sonosStopFade());
      return send(res, 404, { error: "not found" });
    } catch (e) {
      if (path.startsWith("/sonos/")) console.error(new Date().toISOString(), path, e.message);
      return send(res, e.status || (path.startsWith("/sonos/") ? 503 : 400), { error: e.message });
    }
  }

  try {
    // Quick check for the dashboard's status light; doesn't contact Ring.
    if (path === "/health") return send(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    if (path === "/push/key") return send(res, 200, { publicKey: publicKey() });

    const art = path.match(/^\/sonos\/art\/([^/]+)$/);
    if (art) {
      const img = await sonosArt(decodeURIComponent(art[1])).catch(() => null);
      return img ? send(res, 200, img.body, img.type) : send(res, 404, { error: "no artwork" });
    }

    if (path === "/sonos/rooms") {
      try { return send(res, 200, await sonosRooms()); } catch (e) {
        console.error(new Date().toISOString(), path, e.message);
        return send(res, 503, { error: e.message });
      }
    }

    if (path === "/ring/cameras") {
      const cameras = await getCameras();
      return send(res, 200, cameras.map((c) => ({
        id: String(c.id),
        name: c.name,
        offline: Boolean(c.isOffline),
        battery: c.batteryLevel ?? null,
      })));
    }

    const m = path.match(/^\/ring\/cameras\/([^/]+)\/snapshot$/);
    if (m) {
      const camera = (await getCameras()).find((c) => String(c.id) === decodeURIComponent(m[1]));
      if (!camera) return send(res, 404, { error: "no such camera" });
      return send(res, 200, await getSnapshot(camera), "image/jpeg");
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(new Date().toISOString(), path, e.message);
    send(res, 503, { error: "Ring didn't return a snapshot" });
  }
});

// Listen on this PC only; the tunnel forwards requests from the internet.
server.listen(PORT, "127.0.0.1", () => console.log(`Ring helper on http://127.0.0.1:${PORT}`));
