// Train arrival alerts: keeps the phone's push subscriptions and the trains
// being watched, checks each train every minute, and sends a notification
// when it's due at your station within ALERT_MINUTES.
// State lives in push-state.json (git-ignored) so it survives restarts.

import { readFileSync, writeFileSync } from "node:fs";
import { loadVapid, sendPush } from "./push.js";

const TRAINS_API = "https://huxley2.azurewebsites.net";
const ALERT_MINUTES = Number(process.env.ALERT_MINUTES || 10);
const WATCH_HOURS = 4;
const SUBJECT = process.env.PUSH_SUBJECT || "https://geedubyah2.github.io/iPhoneDashboard/";

const STATE_FILE = new URL("./push-state.json", import.meta.url);
const vapid = loadVapid(new URL("./vapid.json", import.meta.url));

let state = { subscriptions: [], watches: [] };
try { state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) }; } catch { /* first run */ }
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));

export const publicKey = () => vapid.publicKey;
export const phoneCount = () => state.subscriptions.length;

export function addSubscription(sub) {
  if (!sub?.endpoint?.startsWith("https://") || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error("bad subscription");
  state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
  state.subscriptions.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
  save();
}

export function watchTrain({ id, crs, station, std }) {
  if (!id || !/^[A-Z]{3}$/.test(crs || "")) throw new Error("bad watch");
  state.watches = [{ id, crs, station: String(station || crs).slice(0, 60), std: String(std || "").slice(0, 5), notified: false, since: Date.now() }];
  save();
  checkTrains(); // in case it's already close
}

export function unwatchTrain() {
  state.watches = [];
  save();
}

export async function notifyAll(payload) {
  const results = [];
  for (const sub of [...state.subscriptions]) {
    try {
      const r = await sendPush(vapid, sub, payload, SUBJECT);
      results.push(r.status);
      if (r.status === 404 || r.status === 410) { // the phone dropped this subscription
        state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
        save();
      } else if (r.status >= 400) {
        console.error(new Date().toISOString(), "push rejected", r.status, r.detail);
      }
    } catch (e) {
      console.error(new Date().toISOString(), "push failed", e.message);
      results.push(0);
    }
  }
  return results;
}

// Minutes from now (London time) until hh:mm, handling midnight; negative if it's passed.
const isTime = (v) => /^\d\d:\d\d$/.test(v || "");
function minutesUntil(hhmm) {
  const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date()).split(":").map(Number);
  const diff = (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) - (h * 60 + m) + 1440) % 1440;
  return diff > 720 ? diff - 1440 : diff;
}

let checking = false;
export async function checkTrains() {
  if (checking) return;
  checking = true;
  try {
    for (const w of [...state.watches]) {
      if (Date.now() - w.since > WATCH_HOURS * 3600 * 1000) { unwatchTrain(); continue; }
      if (w.notified) continue;
      const res = await fetch(`${TRAINS_API}/service/${encodeURIComponent(w.id)}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const d = await res.json();
      const pts = (g) => (g || []).flatMap((x) => x.callingPoint || []);
      const stops = [...pts(d.previousCallingPoints), { crs: d.crs, st: d.std, et: d.etd, at: d.atd }, ...pts(d.subsequentCallingPoints)];
      const stop = stops.find((s) => s.crs === w.crs);
      if (!stop || stop.at) { if (stop?.at) unwatchTrain(); continue; } // arrived already
      const due = isTime(stop.et) ? stop.et : stop.st;
      if (!isTime(due)) continue; // e.g. "Cancelled" or "Delayed" with no estimate
      const mins = minutesUntil(due);
      if (mins <= ALERT_MINUTES && mins >= -5) {
        w.notified = true;
        save();
        await notifyAll({
          title: `Train due at ${w.station} soon`,
          body: `Your ${w.std} train is due at ${w.station} at ${due}${mins > 0 ? ` (${mins} min)` : ""}.`,
          tag: "train-" + w.id,
        });
      }
    }
  } catch (e) {
    console.error(new Date().toISOString(), "train check failed", e.message);
  } finally {
    checking = false;
  }
}

setInterval(checkTrains, 60 * 1000);
