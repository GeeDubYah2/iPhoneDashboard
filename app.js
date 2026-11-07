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
    return setBody("trains", `<p class="muted">Set your two stations in Settings to see trains.</p>`);
  }
  const switchHour = Number.isInteger(cfg.switchHour) ? cfg.switchHour : 12;
  // Before the switch hour (London time): A to B. From then on: B to A.
  const [from, to] = londonHour() < switchHour ? [cfg.stationA, cfg.stationB] : [cfg.stationB, cfg.stationA];
  const operator = cfg.operator !== undefined ? cfg.operator : t.operator;
  const fetchRows = operator ? t.rows * 3 : t.rows; // fetch extra, then filter by operator
  const res = await fetch(`${t.api}/departures/${from}/to/${to}/${fetchRows}?expand=true`); // expand adds calling points
  if (!res.ok) throw new Error("departure board " + res.status);
  const d = await res.json();
  const list = (d.trainServices || [])
    .filter((x) => !operator || !x.operatorCode || x.operatorCode === operator)
    .slice(0, t.rows);
  const station = esc(d.locationName || from);
  const route = `${station} to ${esc(d.filterLocationName || to)}`;
  if (!list.length) return setBody("trains", `<p class="muted">No upcoming trains from ${route}.</p>`);

  const items = list.map((s) => {
    const status = s.isCancelled ? "Cancelled" : s.etd;
    const cls = s.isCancelled ? "bad" : status === "On time" ? "good" : "warn";
    const dest = esc(s.destination?.[0]?.locationName || "");
    const plat = s.platform ? ` <span class="muted small">pl. ${esc(s.platform)}</span>` : "";
    // Expected arrival at your destination: the live estimate if there is one, otherwise the timetable.
    const stop = (s.subsequentCallingPoints || []).flatMap((g) => g.callingPoint || []).find((p) => p.crs === to);
    const arr = stop ? (/^\d\d:\d\d$/.test(stop.et) ? stop.et : stop.st) : "";
    const arrives = arr ? `<div class="muted small">Arrives ${esc(arr)}</div>` : "";
    return `<div class="row"><span class="time">${esc(s.std)}</span>` +
      `<span class="grow">${dest}${plat}${arrives}</span><span class="${cls}">${esc(status)}</span></div>`;
  }).join("");
  setBody("trains", `<p class="muted small">${route}</p>${items}`);
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

async function loadCamera() {
  if (!ringHelper()) {
    setCameraBadge(true);
    return setBody("camera",
      `<div class="cams">${DEMO_CAMERAS.map((n) => cameraTile(n, "", "Snapshot")).join("")}</div>` +
      `<p class="muted small cam-note">Add your Ring helper in Settings to see real snapshots.</p>`);
  }
  setCameraBadge(false);

  const cameras = await (await ringFetch("/ring/cameras")).json();
  if (!cameras.length) return setBody("camera", `<p class="muted">No cameras found on the Ring account.</p>`);

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

  const now = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  setBody("camera",
    `<div class="cams">${cameras.map((c, i) => cameraTile(c.name, shots[i], c.offline ? "Offline" : "No snapshot yet")).join("")}</div>` +
    `<p class="muted small cam-note">Updated ${now} · tap a camera to enlarge</p>`);
}

// Traffic light in Settings → Status: green when the helper answers and accepts the token.
let statusCheck = 0;
async function loadStatus() {
  const mine = ++statusCheck; // only the latest check may update the light
  const set = (colour, text) => {
    if (mine !== statusCheck) return;
    $("#helper-light").className = "light " + colour;
    $("#helper-state").textContent = text;
  };
  if (!ringHelper()) return set("red", "not set up yet (add it below)");
  set("", "checking…");
  try {
    await ringFetch("/health", 8000);
    set("green", "running and connected");
  } catch (e) {
    set("red", e.message);
  }
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
  if (!apps.length) {
    return setBody("apps", `<p class="muted small">Add buttons for your apps in Settings → App buttons.</p>`);
  }
  setBody("apps", `<div class="apps">${apps.map((a) =>
    `<a class="app-btn" href="${esc(appLink(a.target))}">${appIcon(a, "app-icon") || ICON_OPEN}<span>${esc(a.label)}</span></a>`).join("")}</div>`);
}

const ICON_UP = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
const ICON_DOWN = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

// The rows being edited in Settings, including icons found earlier.
let appDraft = [];

function renderAppRows(rows = getSettings().apps || []) {
  appDraft = Array.from({ length: APP_SLOTS }, (_, i) => ({ ...(rows[i] || {}) }));
  $("#app-rows").innerHTML = appDraft.map((a, i) => {
    const preview = appIcon(a, "app-preview") || `<span class="app-preview"></span>`;
    return `<div class="app-row" title="${esc(a.storeName || "")}">${preview}` +
      `<input data-app-label="${i}" type="text" placeholder="Label" value="${esc(a.label || "")}" autocomplete="off" aria-label="Button ${i + 1} label">` +
      `<input data-app-target="${i}" type="text" placeholder="Shortcut name or link" value="${esc(a.target || "")}" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" aria-label="Button ${i + 1} shortcut or link">` +
      `<div class="app-move">` +
      `<button type="button" data-app-move="${i}:-1" aria-label="Move button ${i + 1} up"${i === 0 ? " disabled" : ""}>${ICON_UP}</button>` +
      `<button type="button" data-app-move="${i}:1" aria-label="Move button ${i + 1} down"${i === APP_SLOTS - 1 ? " disabled" : ""}>${ICON_DOWN}</button>` +
      `</div></div>`;
  }).join("");
}

// Swaps a row with its neighbour, keeping anything typed but not yet saved.
// The new order takes effect when you tap Save.
function moveAppRow(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= APP_SLOTS) return;
  const rows = appDraft.map((a, k) => ({
    ...a,
    label: $(`[data-app-label="${k}"]`).value,
    target: $(`[data-app-target="${k}"]`).value,
  }));
  [rows[i], rows[j]] = [rows[j], rows[i]];
  renderAppRows(rows);
  $(`[data-app-move="${j}:${dir}"]`)?.focus();
}

async function saveAppSettings() {
  const old = getSettings().apps || [];
  const apps = [];
  for (let i = 0; i < APP_SLOTS; i++) {
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
  camera: loadCamera, calendar: loadCalendar, tuya: loadDevices, status: loadStatus, apps: loadApps,
};

async function guard(id) {
  try { await LOADERS[id](); }
  catch (e) { setBody(id, `<p class="muted">Couldn't load (${esc(e.message)}).</p>`); }
}

function loadAll() {
  const ids = currentTab === "devices" ? ["tuya"] : currentTab === "home" ? ["weather", "trains", "camera", "apps"] /* add "thermostat" and "calendar" back here, plus their cards in index.html */
    : currentTab === "settings" ? ["status"] : [];
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

  $("#mode").textContent = LIVE
    ? "Connected to " + CONFIG.apiBase.replace(/^https?:\/\//, "")
    : "Demo mode: no API is set in app.js yet, so the devices show sample data. The cameras use the Ring helper set below.";
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
  $("#ringUrl").value = saved.ring?.url || "";
  $("#ringToken").value = saved.ring?.token || "";
  $("#save-ring").addEventListener("click", saveRingSettings);
  renderAppRows();
  $("#save-apps").addEventListener("click", saveAppSettings);
  $("#zoom").addEventListener("click", () => { $("#zoom").hidden = true; });

  document.addEventListener("click", (e) => {
    const zoom = e.target.closest("[data-zoom]");
    if (zoom) return zoomCamera(zoom);
    const move = e.target.closest("[data-app-move]");
    if (move) {
      const [i, dir] = move.dataset.appMove.split(":").map(Number);
      return moveAppRow(i, dir);
    }
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

  showTab(["home", "devices", "settings"].includes(store.get("tab")) ? store.get("tab") : "home");

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

init();
