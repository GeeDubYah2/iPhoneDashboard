// Ring helper for the iPhone dashboard.
// Runs on a home PC, signs in to Ring with a refresh token and serves
// camera snapshots to the dashboard. Settings come from .env (never committed).
//
//   GET /ring/cameras               -> [{ id, name, offline, battery }]
//   GET /ring/cameras/:id/snapshot  -> image/jpeg
//
// Every request needs "Authorization: Bearer <DASHBOARD_TOKEN>".

import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { RingApi } from "ring-client-api";

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

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return send(res, 204, "", "text/plain");
  if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
  if (!authorised(req)) return send(res, 401, { error: "unauthorised" });

  const path = new URL(req.url, "http://x").pathname;
  try {
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
