"use strict";

/* ------------------------------------------------------------------
   Configuration — edit this block.
   Leave apiBase empty to run in demo mode (fake data for the Hive,
   Ring, calendar and Tuya cards). Weather and trains work without it.
------------------------------------------------------------------- */
const CONFIG = {
  apiBase: "", // e.g. "https://dashboard-api.example.com" (HTTPS, no trailing slash)
  weather: {
    useDeviceLocation: true, // ask the phone for its location; falls back to the place below
    name: "London", lat: 51.5072, lon: -0.1276, // generic default; set your own fallback town in Settings
  },
  trains: {
    // Your stations, switch hour and operator are set in the Settings tab (stored on your phone only).
    rows: 2, // how many upcoming trains to show
    operator: "", // default train operator code, e.g. "VT"; blank means every operator
    api: "https://huxley2.azurewebsites.net", // unofficial National Rail proxy
  },
  cameraRefreshSeconds: 60, // Ring battery cameras can't take snapshots much faster than this
};

/* ------------------------------------------------------------------ */

const $ = (s) => document.querySelector(s);
const LIVE = Boolean(CONFIG.apiBase);

const store = {
  get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function setBody(id, html) { $("#" + id + " .body").innerHTML = html; }

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

async function api(path, opts = {}) {
  const res = await fetch(CONFIG.apiBase + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(store.get("token") ? { Authorization: "Bearer " + store.get("token") } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error("API " + res.status);
  return res;
}
const apiJson = async (path, opts) => (await api(path, opts)).json();

/* ------------- Personal settings (stored on this phone only) ------------- */

function getSettings() {
  try { return JSON.parse(store.get("settings")) || {}; } catch { return {}; }
}
function saveSettings(s) { store.set("settings", JSON.stringify(s)); }

/* ---------------------------- Weather ----------------------------- */

const WMO = {
  0: ["☀️", "Clear"], 1: ["🌤️", "Mostly clear"], 2: ["⛅", "Partly cloudy"], 3: ["☁️", "Overcast"],
  45: ["🌫️", "Fog"], 48: ["🌫️", "Freezing fog"],
  51: ["🌦️", "Light drizzle"], 53: ["🌦️", "Drizzle"], 55: ["🌧️", "Heavy drizzle"],
  61: ["🌧️", "Light rain"], 63: ["🌧️", "Rain"], 65: ["🌧️", "Heavy rain"],
  71: ["🌨️", "Light snow"], 73: ["🌨️", "Snow"], 75: ["❄️", "Heavy snow"],
  80: ["🌦️", "Showers"], 81: ["🌧️", "Showers"], 82: ["⛈️", "Heavy showers"],
  95: ["⛈️", "Thunderstorm"], 96: ["⛈️", "Thunderstorm"], 99: ["⛈️", "Thunderstorm"],
};
const wx = (code) => WMO[code] || ["🌡️", ""];

function getPosition() {
  return new Promise((resolve) => {
    if (!CONFIG.weather.useDeviceLocation || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => resolve(null), // declined, unavailable or timed out
      { timeout: 8000, maximumAge: 10 * 60 * 1000 }
    );
  });
}

function cachedPosition() {
  if (!CONFIG.weather.useDeviceLocation) return null;
  try { return JSON.parse(store.get("loc")) || null; } catch { return null; }
}

async function placeName(lat, lon) {
  const key = lat.toFixed(2) + "," + lon.toFixed(2); // roughly 1 km, so we don't look up on every refresh
  try {
    const cached = JSON.parse(store.get("place"));
    if (cached?.key === key && cached.name) return cached.name;
  } catch { /* nothing cached yet */ }
  try {
    const res = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
      { signal: AbortSignal.timeout(4000) }
    );
    const g = await res.json();
    const name = g.locality || g.city || g.principalSubdivision;
    if (name) {
      store.set("place", JSON.stringify({ key, name }));
      return name;
    }
  } catch { /* offline or blocked */ }
  return "Your location";
}

// The 💼 button switches the card between home (phone location, then the
// home town) and the work location. The choice is remembered on this phone.
function showingWork() {
  return store.get("wxPlace") === "work" && Boolean(getSettings().work);
}

const ICON_WORK = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7M3 13h18"/></svg>';
const ICON_HOME = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9v11a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9"/></svg>';

// Shows a briefcase while home weather is on screen, and a house while work weather is.
function updateWorkButton() {
  const on = showingWork();
  const btn = $("#wx-work");
  btn.innerHTML = on ? ICON_HOME : ICON_WORK;
  btn.setAttribute("aria-pressed", String(on));
  btn.setAttribute("aria-label", on ? "Show weather at home" : "Show weather at work");
}

function toggleWorkWeather() {
  if (!getSettings().work) return toast("Add your work location in Settings first");
  store.set("wxPlace", showingWork() ? "home" : "work");
  guard("weather");
}

async function loadWeather() {
  updateWorkButton();
  let { lat, lon, name } = CONFIG.weather;
  const settings = getSettings();
  let namePromise;

  if (showingWork()) {
    ({ lat, lon, name } = settings.work);
    namePromise = Promise.resolve("Work · " + name);
  } else {
    if (settings.town) ({ lat, lon, name } = settings.town); // your home fallback town, if you've set one
    namePromise = Promise.resolve(name);
    const pos = (await getPosition()) || cachedPosition();
    if (pos) {
      ({ lat, lon } = pos);
      namePromise = placeName(lat, lon); // looked up alongside the forecast
      store.set("loc", JSON.stringify(pos));
    }
  }
  const url = "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}&longitude=${lon}` +
    "&current=temperature_2m,weather_code" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
    "&timezone=auto&forecast_days=1";
  const res = await fetch(url);
  if (!res.ok) throw new Error("weather " + res.status);
  const d = await res.json();

  const [icon, label] = wx(d.current.weather_code);
  const todayLabel = wx(d.daily.weather_code[0])[1];
  const rain = d.daily.precipitation_probability_max?.[0];
  name = await namePromise;

  setBody("weather",
    `<div class="wx-now"><span class="temp">${Math.round(d.current.temperature_2m)}°</span>` +
    `<div><div>${icon} ${label}</div><div class="muted small">${esc(name)}</div></div></div>` +
    `<p class="muted">Today: ${todayLabel ? todayLabel.toLowerCase() + ", " : ""}` +
    `${Math.round(d.daily.temperature_2m_min[0])}° to ${Math.round(d.daily.temperature_2m_max[0])}°` +
    `${rain != null ? `, ${rain}% chance of rain` : ""}</p>`);
}

/* ----------------------------- Trains ----------------------------- */

function londonHour() {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
}

async function loadTrains() {
  const t = CONFIG.trains;
  const cfg = getSettings();
  if (!cfg.stationA || !cfg.stationB) {
    $("#train-route").textContent = "";
    return setBody("trains", `<p class="muted">Set your two stations in Settings to see trains.</p>`);
  }
  const switchHour = Number.isInteger(cfg.switchHour) ? cfg.switchHour : 12;
  // Before the switch hour (London time): Home (stationA) to Work (stationB). From then on: Work to Home.
  const [from, to] = londonHour() < switchHour ? [cfg.stationA, cfg.stationB] : [cfg.stationB, cfg.stationA];
  const operator = cfg.operator !== undefined ? cfg.operator : t.operator;
  const fetchRows = operator ? t.rows * 3 : t.rows; // fetch extra, then filter by operator
  const res = await fetch(`${t.api}/departures/${from}/to/${to}/${fetchRows}?expand=true`); // expand adds calling points
  if (!res.ok) throw new Error("departure board " + res.status);
  const d = await res.json();
  const list = (d.trainServices || [])
    .filter((x) => !operator || !x.operatorCode || x.operatorCode === operator)
    .slice(0, t.rows);
  const route = `${d.locationName || from} to ${d.filterLocationName || to}`;
  $("#train-route").textContent = route; // shown beside the "Trains" label

  trainRoute = { from, to };
  trainList = list.map((s) => {
    // Expected arrival at your destination: the live estimate if there is one, otherwise the timetable.
    const stop = (s.subsequentCallingPoints || []).flatMap((g) => g.callingPoint || []).find((p) => p.crs === to);
    return {
      id: s.serviceIdGuid || "",
      std: s.std,
      status: s.isCancelled ? "Cancelled" : s.etd,
      cancelled: s.isCancelled,
      dest: s.destination?.[0]?.locationName || "",
      platform: s.platform || "",
      arr: stop ? (isTime(stop.et) ? stop.et : stop.st) : "",
      from, to,
      toName: d.filterLocationName || to,
    };
  });

  // The train you're on stays at the top, even after it has left your station.
  const mine = getMyTrain();
  const mineGone = mine && !trainList.some((x) => x.id === mine.id);
  const items = (mineGone ? [{ ...mine, departed: true }] : []).concat(trainList).map(trainRow).join("");

  if (!items) return setBody("trains", `<p class="muted">No upcoming trains.</p>`);
  setBody("trains", items);

  if (mineGone && !openTrain) openTrain = mine.id; // show where your train is
  const shown = [...(mineGone ? [mine.id] : []), ...trainList.map((x) => x.id)];
  if (openTrain && shown.includes(openTrain)) loadTrainDetail(openTrain);
  else openTrain = null;
}

function trainRow(s) {
  const id = esc(s.id);
  const picked = getMyTrain()?.id === s.id;
  const status = s.departed ? "Departed" : s.status;
  const cls = s.departed ? "muted" : s.cancelled ? "bad" : status === "On time" ? "good" : "warn";
  const plat = s.platform && !s.departed ? ` <span class="muted small">pl. ${esc(s.platform)}</span>` : "";
  const arrives = s.arr ? `<div class="muted small">Arrives ${esc(s.arr)}</div>` : "";
  const pick = `<button type="button" class="pick" data-pick="${id}" aria-pressed="${picked}" ` +
    `aria-label="${picked ? "Stop following" : "I'm on"} the ${esc(s.std)} to ${esc(s.dest)}">${picked ? ICON_TICK : ""}</button>`;
  return `<div class="row train${picked ? " picked" : ""}" role="button" tabindex="0" aria-expanded="false" data-train="${id}">` +
    `${pick}<span class="time">${esc(s.std)}</span>` +
    `<span class="grow">${esc(s.dest)}${plat}${arrives}</span><span class="${cls}">${esc(status)}</span>` +
    `<span class="chev" aria-hidden="true">${ICON_CHEVRON}</span></div>` +
    `<div class="train-detail" data-train-detail="${id}" hidden></div>`;
}

/* ------------------------ The train you're on ------------------------ */
// Saved on this phone. Clears itself after 4 hours in case you forget.

const ICON_TICK = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12.5l4 4 8-9"/></svg>';
const MY_TRAIN_HOURS = 4;
let trainList = [];

function getMyTrain() {
  try {
    const t = JSON.parse(store.get("myTrain"));
    if (t?.id && Date.now() - t.pickedAt < MY_TRAIN_HOURS * 3600 * 1000) return t;
  } catch { /* nothing saved */ }
  return null;
}

async function togglePick(id) {
  const mine = getMyTrain();
  if (mine?.id === id) {
    const ok = await confirmSheet(`Stop following the ${mine.std} to ${mine.dest}?`, "Yes, stop");
    if (!ok) return;
    store.set("myTrain", "");
    if (openTrain === id) openTrain = null;
  } else {
    const t = trainList.find((x) => x.id === id);
    if (!t) return;
    store.set("myTrain", JSON.stringify({ ...t, pickedAt: Date.now() }));
  }
  syncTrainAlert();
  guard("trains");
}

/* ------------------------- Train arrival alerts ------------------------- */
// The bell beside each station turns on a push notification 10 minutes before
// the train you're on reaches that station. The home helper watches the train
// and sends the notification, so it works with the dashboard closed.

const ICON_BELL = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>';

async function helperPost(path, body) {
  const h = ringHelper();
  const res = await fetch(h.url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(h.token ? { Authorization: "Bearer " + h.token } : {}) },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 404) throw new Error("the home helper needs updating");
  if (!res.ok) throw new Error("home helper " + res.status);
  return res.json();
}

const notifyOn = (which) => Boolean(getSettings().notify?.[which]);

function updateBells() {
  document.querySelectorAll("[data-notify]").forEach((b) => {
    const on = notifyOn(b.dataset.notify);
    b.innerHTML = ICON_BELL;
    b.setAttribute("aria-pressed", String(on));
  });
}

const b64ToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

// Asks permission (first time only) and registers this phone with the helper.
async function enablePush() {
  if (!ringHelper()) throw new Error("set up the Ring helper first (Settings → Ring cameras)");
  if (!("Notification" in window) || !("PushManager" in window) || !navigator.serviceWorker) {
    throw new Error("open the dashboard from your Home Screen to allow notifications");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("notifications are turned off for the dashboard in iPhone Settings");
  const { publicKey } = await (await ringFetch("/push/key", 10000)).json();
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await helperPost("/push/subscribe", sub.toJSON());
}

async function toggleNotify(btn) {
  const which = btn.dataset.notify;
  const next = getSettings();
  const turningOn = !notifyOn(which);
  btn.disabled = true;
  try {
    if (turningOn) await enablePush();
    next.notify = { ...(next.notify || {}), [which]: turningOn };
    saveSettings(next);
    toast(turningOn ? `Alerts on for trains to your ${which} station` : `Alerts off for your ${which} station`);
    syncTrainAlert();
  } catch (e) {
    toast("Couldn't turn on alerts: " + e.message);
  } finally {
    btn.disabled = false;
    updateBells();
  }
}

// Tells the helper which train to watch: the one you're on, if its destination has alerts on.
async function syncTrainAlert() {
  const cfg = getSettings();
  if (!ringHelper() || !(cfg.notify?.home || cfg.notify?.work)) return;
  const mine = getMyTrain();
  const which = mine && (mine.to === cfg.stationA ? "home" : mine.to === cfg.stationB ? "work" : "");
  try {
    if (which && cfg.notify?.[which]) {
      await helperPost("/push/watch", { id: mine.id, crs: mine.to, station: mine.toName || mine.to, std: mine.std });
    } else {
      await helperPost("/push/unwatch");
    }
  } catch (e) {
    toast("Train alert not set: " + e.message);
  }
}

// Settings → Notifications: registers this phone if needed, then asks the
// helper to send a test in 5 seconds (time to lock the phone).
async function sendTestPush() {
  const btn = $("#test-push");
  btn.disabled = true;
  try {
    await enablePush();
    await helperPost("/push/test", { delaySeconds: 5 });
    toast("Test notification coming in 5 seconds");
  } catch (e) {
    toast("Couldn't send: " + e.message);
  } finally {
    setTimeout(() => { btn.disabled = false; }, 5000);
  }
}

// A small panel that slides up from the bottom; resolves true for the main button.
function confirmSheet(text, okLabel) {
  const sheet = $("#sheet");
  $("#sheet-text").textContent = text;
  $("#sheet-ok").textContent = okLabel;
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add("open"));
  $("#sheet-ok").focus();
  return new Promise((resolve) => {
    const done = (answer) => {
      sheet.classList.remove("open");
      setTimeout(() => { sheet.hidden = true; }, 200);
      sheet.onclick = null;
      document.removeEventListener("keydown", onKey);
      resolve(answer);
    };
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    document.addEventListener("keydown", onKey);
    sheet.onclick = (e) => {
      if (e.target.id === "sheet-ok") done(true);
      else if (e.target.id === "sheet-cancel" || e.target === sheet) done(false);
    };
  });
}

/* ---------------------- Train journey details ---------------------- */
// Tapping a train shows every stop: where it has been (actual times), roughly
// where it is now, and when it's expected at each stop still to come.

const ICON_CHEVRON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
let trainRoute = { from: "", to: "" };
let openTrain = null; // the train whose journey is open, kept across refreshes

const isTime = (v) => /^\d\d:\d\d$/.test(v || "");
const toMins = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
function minsLate(actual, scheduled) {
  if (!isTime(actual) || !isTime(scheduled)) return 0;
  const d = (toMins(actual) - toMins(scheduled) + 1440) % 1440; // handles midnight
  return d > 720 ? d - 1440 : d;
}
const lateText = (m) => (m > 0 ? `${m} min late` : m < 0 ? `${-m} min early` : "on time");

function toggleTrain(id) {
  const opening = openTrain !== id;
  document.querySelectorAll("[data-train]").forEach((r) => r.setAttribute("aria-expanded", "false"));
  document.querySelectorAll("[data-train-detail]").forEach((b) => { b.hidden = true; });
  openTrain = opening ? id : null;
  if (opening) loadTrainDetail(id);
}

async function loadTrainDetail(id) {
  const row = $(`[data-train="${CSS.escape(id)}"]`);
  const box = $(`[data-train-detail="${CSS.escape(id)}"]`);
  if (!row || !box) return;
  row.setAttribute("aria-expanded", "true");
  box.hidden = false;
  if (!box.innerHTML) box.innerHTML = `<p class="muted small">Loading journey…</p>`;

  let d;
  try {
    const res = await fetch(`${CONFIG.trains.api}/service/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error();
    d = await res.json();
  } catch {
    box.innerHTML = `<p class="muted small">Couldn't load this train's journey.</p>`;
    return;
  }
  if (openTrain !== id) return; // closed while loading

  const pts = (groups) => (groups || []).flatMap((g) => g.callingPoint || []);
  const stops = [
    ...pts(d.previousCallingPoints).map((p) => ({ ...p })),
    { locationName: d.locationName, crs: d.crs, st: d.std, et: d.etd, at: d.atd, platform: d.platform, isCancelled: d.isCancelled },
    ...pts(d.subsequentCallingPoints).map((p) => ({ ...p })),
  ];
  const pinned = getMyTrain();
  const route = pinned?.id === id ? pinned : trainRoute; // your stations for this train
  let last = -1; // last stop the train has actually left
  stops.forEach((s, i) => { if (s.at) last = i; });

  // Keep the pinned train's "Arrives" time live.
  const dest = pinned?.id === id && stops.find((s) => s.crs === pinned.to);
  if (dest) {
    const arr = isTime(dest.at) ? dest.at : isTime(dest.et) ? dest.et : dest.st;
    if (arr && arr !== pinned.arr) {
      store.set("myTrain", JSON.stringify({ ...pinned, arr }));
      const line = row.querySelector(".grow .small");
      if (line) line.textContent = (isTime(dest.at) ? "Arrived " : "Arrives ") + arr;
    }
  }

  let where = ""; // nothing to say for a train that hasn't set off yet
  if (d.isCancelled) where = `<span class="bad">This train is cancelled</span>${d.cancelReason ? ` · ${esc(d.cancelReason)}` : ""}`;
  else if (last < 0) where = "";
  else if (last === stops.length - 1) where = `Arrived at ${esc(stops[last].locationName)}`;
  else {
    const s = stops[last];
    const t = isTime(s.at) ? s.at : s.st;
    where = `Left ${esc(s.locationName)} at ${esc(t)} · ${lateText(minsLate(s.at, s.st))}`;
  }

  const items = stops.map((s, i) => {
    const passed = i <= last;
    const mine = s.crs === route.from || s.crs === route.to;
    const cancelled = s.isCancelled || s.et === "Cancelled";
    let time = s.st;
    let note = "";
    if (passed) {
      time = isTime(s.at) ? s.at : s.st;
      const late = minsLate(s.at, s.st);
      if (late) note = `<span class="${late > 0 ? "warn" : "good"}">${late > 0 ? "+" : ""}${late}</span>`;
    } else if (cancelled) {
      note = `<span class="bad">Cancelled</span>`;
    } else if (isTime(s.et) && s.et !== s.st) {
      time = s.et;
      note = `<span class="warn">was ${esc(s.st)}</span>`;
    } else if (s.et && !isTime(s.et) && s.et !== "On time") {
      note = `<span class="warn">${esc(s.et)}</span>`;
    }
    const plat = mine && s.platform ? ` <span class="muted">pl. ${esc(s.platform)}</span>` : "";
    const here = i === last && last < stops.length - 1 && !d.isCancelled
      ? `<li class="here"><span></span><span class="dot"></span><span class="small">Train is here</span><span></span></li>` : "";
    return `<li class="${passed ? "passed" : ""}${mine ? " mine" : ""}">` +
      `<span class="time">${esc(time || "")}</span><span class="dot"></span>` +
      `<span class="stop">${esc(s.locationName)}${plat}</span><span class="small">${note}</span></li>${here}`;
  }).join("");

  box.innerHTML = (where ? `<p class="small train-where">${where}</p>` : "") + `<ul class="stops">${items}</ul>`;
}

/* --------------------------- Thermostat --------------------------- */

const thermo = { current: 19.5, target: 20, heating: false };
let thermoTimer;

function renderThermostat() {
  const t = thermo;
  setBody("thermostat",
    `<div class="thermo">` +
    `<button class="round" data-delta="-0.5" aria-label="Lower target">−</button>` +
    `<div class="thermo-mid"><div class="temp">${t.target.toFixed(1)}°</div>` +
    `<div class="muted small">Target · now ${t.current.toFixed(1)}°${t.heating ? ' · <span class="warn">heating</span>' : ""}</div></div>` +
    `<button class="round" data-delta="0.5" aria-label="Raise target">+</button></div>`);
}

async function loadThermostat() {
  if (LIVE) Object.assign(thermo, await apiJson("/hive/status"));
  renderThermostat();
}

function nudgeTarget(delta) {
  thermo.target = Math.min(32, Math.max(5, Math.round((thermo.target + delta) * 2) / 2));
  renderThermostat();
  if (!LIVE) return;
  clearTimeout(thermoTimer); // wait for taps to settle before sending
  thermoTimer = setTimeout(() => {
    api("/hive/target", { method: "POST", body: JSON.stringify({ target: thermo.target }) })
      .catch(() => toast("Couldn't set the thermostat"));
  }, 800);
}

/* ----------------------------- Camera ----------------------------- */

// The Ring helper runs at home. Its address and token are set in the
// Settings tab and stored on this phone only, never in this public file.
function ringHelper() {
  const h = getSettings().ring || {};
  return h.url ? h : null;
}

async function ringFetch(path, timeoutMs = 45000) {
  const h = ringHelper();
  let res;
  try {
    res = await fetch(h.url + path, {
      headers: h.token ? { Authorization: "Bearer " + h.token } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error("can't reach the Ring helper; is the PC on?");
  }
  if (res.status === 401) throw new Error("check the access token in Settings");
  if (!res.ok) throw new Error("Ring helper " + res.status);
  return res;
}

let camUrls = [];
const DEMO_CAMERAS = ["Camera 1", "Camera 2", "Camera 3"];

function setCameraBadge(demo) {
  const h2 = $("#camera h2");
  h2.querySelector(".badge")?.remove();
  if (demo) h2.insertAdjacentHTML("beforeend", '<span class="badge">demo</span>');
}

function cameraTile(name, src, note) {
  const img = src
    ? `<img src="${src}" alt="${esc(name)} snapshot" data-zoom>`
    : `<div class="cam-empty">${esc(note || "No snapshot")}</div>`;
  return `<figure class="cam">${img}<figcaption class="small">${esc(name)}</figcaption></figure>`;
}

// The helper's traffic light, shown at the bottom of the Camera card.
function helperStatus(connected) {
  const now = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `<div class="status-row cam-note small"><span class="light ${connected ? "green" : "red"}" aria-hidden="true"></span>` +
    `<span>${connected ? `Connected · updated ${now}` : "Not connected"}</span></div>`;
}

async function loadCamera() {
  if (!ringHelper()) {
    setCameraBadge(true);
    return setBody("camera",
      `<div class="cams">${DEMO_CAMERAS.map((n) => cameraTile(n, "", "Snapshot")).join("")}</div>` +
      helperStatus(false));
  }
  setCameraBadge(false);

  let cameras;
  try {
    cameras = await (await ringFetch("/ring/cameras")).json();
  } catch {
    // Keep the last snapshots on screen; just turn the light red.
    const tiles = $("#camera .cams");
    return setBody("camera", (tiles ? tiles.outerHTML : "") + helperStatus(false));
  }
  if (!cameras.length) return setBody("camera", `<p class="muted">No cameras found on the Ring account.</p>${helperStatus(true)}`);

  const shots = await Promise.all(cameras.map(async (c) => {
    try {
      const blob = await (await ringFetch(`/ring/cameras/${encodeURIComponent(c.id)}/snapshot`)).blob();
      return URL.createObjectURL(blob);
    } catch {
      return "";
    }
  }));

  camUrls.forEach((u) => URL.revokeObjectURL(u));
  camUrls = shots.filter(Boolean);

  setBody("camera",
    `<div class="cams">${cameras.map((c, i) => cameraTile(c.name, shots[i], c.offline ? "Offline" : "No snapshot yet")).join("")}</div>` +
    helperStatus(true));
}

function zoomCamera(img) {
  const box = $("#zoom");
  box.querySelector("img").src = img.src;
  box.querySelector("p").textContent = img.alt.replace(/ snapshot$/, "");
  box.hidden = false;
}

function saveRingSettings() {
  const next = getSettings();
  const url = $("#ringUrl").value.trim().replace(/\/+$/, "");
  const token = $("#ringToken").value.trim();
  // https everywhere; plain http only for testing on the same computer
  if (url && !/^(https:\/\/[^\s/]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)/i.test(url)) return toast("The address must start with https://");
  if (url) next.ring = { url, token };
  else delete next.ring;
  saveSettings(next);
  toast(url ? "Saved" : "Ring helper removed");
  loadAll();
}

/* ------------------------------ Apps ------------------------------ */
// Buttons that open iPhone apps, set up in Settings (stored on this phone only).
// A plain name runs the Shortcut with that name; a link like "someapp://" is used as is.

const APP_SLOTS = 6;
const ICON_OPEN = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

function appLink(target) {
  const t = target.trim();
  const scheme = t.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase();
  if (!scheme) return "shortcuts://run-shortcut?name=" + encodeURIComponent(t);
  return ["javascript", "data", "vbscript", "file", "blob"].includes(scheme) ? "" : t;
}

// App icons come from Apple's public App Store search, looked up when you
// save and remembered on this phone. Only icons hosted by Apple are shown.
const safeIcon = (url) => (/^https:\/\/[a-z0-9.-]+\.mzstatic\.com\//i.test(url || "") ? url : "");

async function findAppIcon(label) {
  const country = (navigator.language.split("-")[1] || "us").toLowerCase();
  try {
    const res = await fetch("https://itunes.apple.com/search?entity=software&limit=1" +
      `&country=${encodeURIComponent(country)}&term=${encodeURIComponent(label)}`, { signal: AbortSignal.timeout(6000) });
    const hit = (await res.json()).results?.[0];
    return hit ? { icon: safeIcon(hit.artworkUrl100), storeName: hit.trackName || "" } : null;
  } catch {
    return null; // offline or blocked; the button falls back to the plain icon
  }
}

function appIcon(a, cls) {
  const src = safeIcon(a.icon);
  return src ? `<img class="${cls}" src="${esc(src)}" alt="" onerror="this.style.visibility='hidden'">` : "";
}


function loadApps() {
  const apps = (getSettings().apps || []).filter((a) => a.label && a.target && appLink(a.target));
  const grid = apps.length ? `<div class="apps">${apps.map((a) =>
    `<a class="app-btn" href="${esc(appLink(a.target))}">${appIcon(a, "app-icon") || ICON_OPEN}<span>${esc(a.label)}</span></a>`).join("")}</div>` : "";
  setBody("apps", grid || `<p class="muted small">Add shortcuts in Settings → App buttons.</p>`);
}

// Settings → "Add shortcut": adds a blank row to fill in, then Save.
function addAppRow() {
  const rows = appRowsOnScreen();
  if (rows.length >= APP_SLOTS) return toast(`You can have up to ${APP_SLOTS} shortcuts`);
  rows.push({});
  renderAppRows(rows);
  $(`[data-app-label="${rows.length - 1}"]`).focus();
}

const ICON_GRIP = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14M5 12h14M5 16h14"/></svg>';

// The rows being edited in Settings, including icons found earlier.
let appDraft = [];

const ICON_X = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';

// Your shortcuts, plus any blank rows added with "Add shortcut". There's always
// at least one row; blank rows aren't saved.
function renderAppRows(rows = getSettings().apps || []) {
  appDraft = (rows.length ? rows : [{}]).map((a) => ({ ...a }));
  $("#app-rows").innerHTML = appDraft.map((a, i) => {
    const preview = appIcon(a, "app-preview") || `<span class="app-preview"></span>`;
    return `<div class="app-row" title="${esc(a.storeName || "")}">${preview}` +
      `<input data-app-label="${i}" type="text" placeholder="Label" value="${esc(a.label || "")}" autocomplete="off" aria-label="Button ${i + 1} label">` +
      `<input data-app-target="${i}" type="text" placeholder="Shortcut name or link" value="${esc(a.target || "")}" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" aria-label="Button ${i + 1} shortcut or link">` +
      `<button type="button" class="app-remove" data-app-remove="${i}" aria-label="Remove ${esc(a.label || "button " + (i + 1))}">${ICON_X}</button>` +
      `<button type="button" class="app-grip" data-app-grip="${i}" aria-label="Reorder button ${i + 1}: drag, or use the up and down arrow keys">${ICON_GRIP}</button>` +
      `</div>`;
  }).join("");
}

// Current rows as edited on screen (including unsaved typing).
const appRowsOnScreen = () => appDraft.map((a, k) => ({
  ...a,
  label: $(`[data-app-label="${k}"]`).value,
  target: $(`[data-app-target="${k}"]`).value,
}));

function removeAppRow(i) {
  const rows = appRowsOnScreen();
  const wasBlank = !rows[i].label.trim() && !rows[i].target.trim();
  rows.splice(i, 1);
  renderAppRows(rows);
  if (!wasBlank) toast("Removed. Tap Save to keep the change");
}

// Moves a row to a new position, keeping anything typed but not yet saved.
// The new order takes effect when you tap Save.
function moveAppRow(from, to) {
  if (to < 0 || to >= appDraft.length || to === from) return;
  const rows = appRowsOnScreen();
  const [row] = rows.splice(from, 1);
  rows.splice(to, 0, row);
  renderAppRows(rows);
}

// Drag a row by its handle. Pointer events cover touch (iPhone) and mouse.
function startAppDrag(e, grip) {
  e.preventDefault();
  const rows = [...document.querySelectorAll("#app-rows .app-row")];
  if (rows.length < 2) return; // nothing to reorder
  const from = Number(grip.dataset.appGrip);
  const row = rows[from];
  const step = rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top;
  const startY = e.clientY;
  let to = from;

  try { grip.setPointerCapture(e.pointerId); } catch { /* not needed for mouse */ }
  row.classList.add("dragging");

  const move = (ev) => {
    const dy = Math.max(-from * step, Math.min((rows.length - 1 - from) * step, ev.clientY - startY));
    row.style.transform = `translateY(${dy}px)`;
    to = from + Math.round(dy / step);
    rows.forEach((r, k) => {
      if (k === from) return;
      const shift = from < to && k > from && k <= to ? -step : from > to && k >= to && k < from ? step : 0;
      r.style.transform = shift ? `translateY(${shift}px)` : "";
    });
  };
  const end = () => {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", end);
    grip.removeEventListener("pointercancel", end);
    rows.forEach((r) => { r.style.transform = ""; });
    row.classList.remove("dragging");
    moveAppRow(from, to);
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
}

async function saveAppSettings() {
  const old = getSettings().apps || [];
  const apps = [];
  for (let i = 0; i < appDraft.length; i++) {
    const label = $(`[data-app-label="${i}"]`).value.trim();
    const target = $(`[data-app-target="${i}"]`).value.trim();
    if (!label && !target) continue;
    if (!label || !target) return toast(`Button ${i + 1} needs both a label and a Shortcut name`);
    if (!appLink(target)) return toast(`Button ${i + 1} has a link type that isn't allowed`);
    apps.push({ label, target });
  }

  // Look up icons for new or renamed buttons; keep the ones already found.
  const btn = $("#save-apps");
  btn.disabled = true;
  btn.textContent = "Finding icons…";
  await Promise.all(apps.map(async (a) => {
    const prev = [...old, ...appDraft].find((o) => o.label === a.label && o.icon);
    const found = prev ? { icon: prev.icon, storeName: prev.storeName } : await findAppIcon(a.label);
    if (found?.icon) Object.assign(a, found);
  }));
  btn.disabled = false;
  btn.textContent = "Save";

  const next = getSettings();
  if (apps.length) next.apps = apps; else delete next.apps;
  saveSettings(next);
  renderAppRows();
  const missing = apps.filter((a) => !a.icon).map((a) => a.label);
  toast(missing.length ? `Saved. No icon found for ${missing.join(", ")}` : "Saved");
}

/* ---------------------------- Calendar ---------------------------- */

function demoEvents() {
  const at = (days, h, m) => { const x = new Date(); x.setDate(x.getDate() + days); x.setHours(h, m, 0, 0); return x.toISOString(); };
  return [
    { title: "Example: dentist", start: at(0, 17, 30) },
    { title: "Example: phone call", start: at(1, 10, 0) },
    { title: "Example: dinner out", start: at(2, 19, 30) },
  ];
}

async function loadCalendar() {
  const events = LIVE ? await apiJson("/calendar") : demoEvents();
  if (!events.length) return setBody("calendar", `<p class="muted">Nothing coming up.</p>`);
  setBody("calendar", events.slice(0, 5).map((e) => {
    const d = new Date(e.start);
    const when = e.allDay
      ? d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
      : d.toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
    return `<div class="row"><span class="grow">${esc(e.title)}</span><span class="muted small">${when}</span></div>`;
  }).join(""));
}

/* ------------------------------ Tuya ------------------------------ */

const DEMO_DEVICES = [
  { id: "demo1", name: "Living room lamp", on: true },
  { id: "demo2", name: "Desk plug", on: false },
  { id: "demo3", name: "Hallway light", on: false },
];
let devices = [];

function renderDevices() {
  setBody("tuya", devices.length
    ? devices.map((d) =>
        `<div class="row"><span class="grow">${esc(d.name)}</span>` +
        `<button class="switch" role="switch" aria-checked="${d.on}" aria-label="${esc(d.name)}" data-device="${esc(d.id)}"></button></div>`).join("")
    : `<p class="muted">No devices found.</p>`);
}

async function loadDevices() {
  if (LIVE) devices = await apiJson("/tuya/devices");
  else if (!devices.length) devices = structuredClone(DEMO_DEVICES);
  renderDevices();
}

async function toggleDevice(id) {
  const d = devices.find((x) => x.id === id);
  if (!d) return;
  d.on = !d.on;
  renderDevices();
  if (!LIVE) return;
  try {
    await api(`/tuya/devices/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ on: d.on }) });
  } catch {
    d.on = !d.on;
    renderDevices();
    toast("Couldn't reach that device");
  }
}

/* ----------------------- Tabs, refresh, setup ---------------------- */

let currentTab = "home";

const LOADERS = {
  weather: loadWeather, trains: loadTrains, thermostat: loadThermostat,
  camera: loadCamera, calendar: loadCalendar, tuya: loadDevices, apps: loadApps,
};

async function guard(id) {
  try { await LOADERS[id](); }
  catch (e) { setBody(id, `<p class="muted">Couldn't load (${esc(e.message)}).</p>`); }
}

function loadAll() {
  const ids = currentTab === "devices" ? ["tuya"] : currentTab === "home" ? ["weather", "trains", "camera", "apps"] /* add "thermostat" and "calendar" back here, plus their cards in index.html */ : [];
  ids.forEach(guard);
}

function showTab(name) {
  currentTab = name;
  document.querySelectorAll(".page").forEach((p) => { p.hidden = p.id !== "page-" + name; });
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  store.set("tab", name);
  loadAll();
}

function greet() {
  const h = new Date().getHours();
  $("#greeting").textContent = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  $("#today").textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

async function geocode(text) {
  const res = await fetch("https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=" + encodeURIComponent(text));
  return (await res.json()).results?.[0] || null;
}

async function saveWeatherSettings() {
  const next = getSettings();
  const found = [];

  // key in settings, input id, name used in messages
  for (const [key, inputId, what] of [["town", "town", "home"], ["work", "workTown", "work"]]) {
    const text = $("#" + inputId).value.trim();
    if (!text) { delete next[key]; continue; }
    if (text === next[key]?.name) continue;
    let hit;
    try { hit = await geocode(text); } catch { return toast(`Couldn't look up the ${what} location`); }
    if (!hit) return toast(`Couldn't find the ${what} location`);
    next[key] = { name: hit.name, lat: hit.latitude, lon: hit.longitude };
    $("#" + inputId).value = hit.name;
    found.push(`${what[0].toUpperCase() + what.slice(1)}: ${[hit.name, hit.admin1, hit.country].filter(Boolean).join(", ")}`);
  }

  if (!next.work && store.get("wxPlace") === "work") store.set("wxPlace", "home");
  saveSettings(next);
  toast(found.length ? "Saved. " + found.join(" · ") : "Saved");
  loadAll();
}

function saveTrainSettings() {
  const next = getSettings();
  const val = (id) => $("#" + id).value.trim().toUpperCase();

  for (const id of ["stationA", "stationB"]) {
    const v = val(id);
    if (v && !/^[A-Z]{3}$/.test(v)) return toast("Station codes are 3 letters");
    next[id] = v;
  }

  const op = val("operator");
  if (op && !/^[A-Z0-9]{2}$/.test(op)) return toast("Operator codes are 2 characters");
  next.operator = op; // blank means every operator

  const hourText = $("#switchHour").value.trim();
  const hour = Number(hourText);
  if (hourText && !(Number.isInteger(hour) && hour >= 0 && hour <= 23)) return toast("Hour must be 0 to 23");
  next.switchHour = hourText ? hour : undefined;

  saveSettings(next);
  toast("Saved");
  loadAll();
}

function init() {
  greet();

  if (!LIVE) {
    ["tuya"].forEach((id) => {
      $("#" + id + " h2").insertAdjacentHTML("beforeend", '<span class="badge">demo</span>');
    });
  }

  const saved = getSettings();
  $("#town").value = saved.town?.name || "";
  $("#workTown").value = saved.work?.name || "";
  $("#wx-work").addEventListener("click", toggleWorkWeather);
  updateWorkButton();
  $("#stationA").value = saved.stationA || "";
  $("#stationB").value = saved.stationB || "";
  $("#switchHour").value = Number.isInteger(saved.switchHour) ? saved.switchHour : "";
  $("#operator").value = saved.operator !== undefined ? saved.operator : CONFIG.trains.operator;
  $("#save-weather").addEventListener("click", saveWeatherSettings);
  $("#save-trains").addEventListener("click", saveTrainSettings);
  $("#test-push").addEventListener("click", sendTestPush);
  updateBells();
  $("#ringUrl").value = saved.ring?.url || "";
  $("#ringToken").value = saved.ring?.token || "";
  $("#save-ring").addEventListener("click", saveRingSettings);
  renderAppRows();
  $("#save-apps").addEventListener("click", saveAppSettings);
  $("#app-rows").addEventListener("pointerdown", (e) => {
    const grip = e.target.closest("[data-app-grip]");
    if (grip && e.isPrimary) startAppDrag(e, grip);
  });
  $("#app-rows").addEventListener("keydown", (e) => {
    const grip = e.target.closest("[data-app-grip]");
    if (!grip || !["ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const from = Number(grip.dataset.appGrip);
    const to = from + (e.key === "ArrowUp" ? -1 : 1);
    moveAppRow(from, to);
    $(`[data-app-grip="${Math.max(0, Math.min(appDraft.length - 1, to))}"]`)?.focus();
  });
  $("#zoom").addEventListener("click", () => { $("#zoom").hidden = true; });

  document.addEventListener("click", (e) => {
    const zoom = e.target.closest("[data-zoom]");
    if (zoom) return zoomCamera(zoom);
    const pick = e.target.closest("[data-pick]");
    if (pick) return togglePick(pick.dataset.pick);
    const bell = e.target.closest("[data-notify]");
    if (bell) return toggleNotify(bell);
    if (e.target.closest("#add-app-row")) return addAppRow();
    const remove = e.target.closest("[data-app-remove]");
    if (remove) return removeAppRow(Number(remove.dataset.appRemove));
    const train = e.target.closest("[data-train]");
    if (train && train.dataset.train) return toggleTrain(train.dataset.train);
    const delta = e.target.closest("[data-delta]");
    if (delta) return nudgeTarget(parseFloat(delta.dataset.delta));
    const sw = e.target.closest("[data-device]");
    if (sw) return toggleDevice(sw.dataset.device);
    const tab = e.target.closest("nav [data-tab]");
    if (tab) showTab(tab.dataset.tab);
  });

  $("#refresh").addEventListener("click", () => { greet(); loadAll(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { greet(); loadAll(); } });

  setInterval(() => {
    if (ringHelper() && currentTab === "home" && document.visibilityState === "visible") guard("camera");
  }, CONFIG.cameraRefreshSeconds * 1000);

  // Keep an open train journey up to date.
  setInterval(() => {
    if (openTrain && currentTab === "home" && document.visibilityState === "visible") loadTrainDetail(openTrain);
  }, 60 * 1000);
  document.addEventListener("keydown", (e) => {
    if (e.target.closest?.("[data-pick]")) return; // the select button handles its own keys
    const train = e.target.closest?.("[data-train]");
    if (train && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggleTrain(train.dataset.train); }
  });

  showTab(["home", "devices", "settings"].includes(store.get("tab")) ? store.get("tab") : "home");

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

init();
