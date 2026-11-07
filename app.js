"use strict";

/* ------------------------------------------------------------------
   Configuration — edit this block.
   Leave apiBase empty to run in demo mode (fake data for the Hive,
   Ring, calendar and Tuya cards). Weather and trains work without it.
------------------------------------------------------------------- */
const CONFIG = {
  apiBase: "", // e.g. "https://dashboard-api.example.com" (HTTPS, no trailing slash)
  weather: { name: "London", lat: 51.5072, lon: -0.1276 },
  trains: {
    from: "KGX", // 3-letter station code to depart from
    to: "",      // optional destination code, e.g. "PBO"; leave "" for all
    rows: 4,
    api: "https://huxley2.azurewebsites.net", // unofficial National Rail proxy
  },
  cameraRefreshSeconds: 15,
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
      Authorization: "Bearer " + store.get("token"),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error("API " + res.status);
  return res;
}
const apiJson = async (path, opts) => (await api(path, opts)).json();

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

async function loadWeather() {
  const { lat, lon, name } = CONFIG.weather;
  const url = "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}&longitude=${lon}` +
    "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m" +
    "&hourly=temperature_2m,weather_code,precipitation_probability" +
    "&daily=temperature_2m_max,temperature_2m_min,weather_code" +
    "&timezone=auto&forecast_days=4&wind_speed_unit=mph";
  const res = await fetch(url);
  if (!res.ok) throw new Error("weather " + res.status);
  const d = await res.json();

  const c = d.current;
  const [icon, label] = wx(c.weather_code);
  const start = Math.max(0, d.hourly.time.findIndex((t) => t > c.time));

  const hours = d.hourly.time.slice(start, start + 8).map((t, i) => {
    const j = start + i;
    return `<div><span class="small muted">${t.slice(11, 16)}</span>` +
      `<span class="big-icon">${wx(d.hourly.weather_code[j])[0]}</span>` +
      `<b>${Math.round(d.hourly.temperature_2m[j])}°</b>` +
      `<span class="small muted">${d.hourly.precipitation_probability[j] ?? 0}%</span></div>`;
  }).join("");

  const days = d.daily.time.map((t, i) => {
    const day = i === 0 ? "Today" : new Date(t + "T12:00").toLocaleDateString("en-GB", { weekday: "short" });
    return `<div class="row"><span class="grow">${day}</span><span>${wx(d.daily.weather_code[i])[0]}</span>` +
      `<span class="small muted">${Math.round(d.daily.temperature_2m_min[i])}°</span>` +
      `<b>${Math.round(d.daily.temperature_2m_max[i])}°</b></div>`;
  }).join("");

  setBody("weather",
    `<div class="wx-now"><span class="temp">${Math.round(c.temperature_2m)}°</span>` +
    `<div><div>${icon} ${label}</div><div class="muted small">Feels ${Math.round(c.apparent_temperature)}° · ` +
    `Wind ${Math.round(c.wind_speed_10m)} mph · ${esc(name)}</div></div></div>` +
    `<div class="strip">${hours}</div>${days}`);
}

/* ----------------------------- Trains ----------------------------- */

async function loadTrains() {
  const { from, to, rows, api: base } = CONFIG.trains;
  const path = to ? `/departures/${from}/to/${to}/${rows}` : `/departures/${from}/${rows}`;
  const res = await fetch(base + path);
  if (!res.ok) throw new Error("departure board " + res.status);
  const d = await res.json();
  const list = d.trainServices || [];
  const station = esc(d.locationName || from);
  if (!list.length) return setBody("trains", `<p class="muted">No upcoming departures from ${station}.</p>`);

  const items = list.map((s) => {
    const status = s.isCancelled ? "Cancelled" : s.etd;
    const cls = s.isCancelled ? "bad" : status === "On time" ? "good" : "warn";
    const dest = esc(s.destination?.[0]?.locationName || "");
    const plat = s.platform ? ` <span class="muted small">pl. ${esc(s.platform)}</span>` : "";
    return `<div class="row"><span class="time">${esc(s.std)}</span>` +
      `<span class="grow">${dest}${plat}</span><span class="${cls}">${esc(status)}</span></div>`;
  }).join("");
  setBody("trains", `<p class="muted small">Departing ${station}</p>${items}`);
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

let camUrl = "";

async function loadCamera() {
  if (!LIVE) {
    return setBody("camera", `<div class="placeholder">Ring snapshot appears here once your API is connected.</div>`);
  }
  const blob = await (await api("/ring/snapshot")).blob();
  if (camUrl) URL.revokeObjectURL(camUrl);
  camUrl = URL.createObjectURL(blob);
  const now = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  setBody("camera", `<img src="${camUrl}" alt="Latest camera snapshot"><p class="muted small" style="margin-top:8px">Updated ${now}</p>`);
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
  camera: loadCamera, calendar: loadCalendar, tuya: loadDevices,
};

async function guard(id) {
  try { await LOADERS[id](); }
  catch (e) { setBody(id, `<p class="muted">Couldn't load (${esc(e.message)}).</p>`); }
}

function loadAll() {
  const ids = currentTab === "devices" ? ["tuya"] : currentTab === "home" ? ["weather", "trains", "thermostat", "camera", "calendar"] : [];
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

function init() {
  greet();

  if (!LIVE) {
    ["thermostat", "camera", "calendar", "tuya"].forEach((id) => {
      $("#" + id + " h2").insertAdjacentHTML("beforeend", '<span class="badge">demo</span>');
    });
  }

  $("#mode").textContent = LIVE
    ? "Connected to " + CONFIG.apiBase.replace(/^https?:\/\//, "")
    : "Demo mode: no API is set in app.js yet, so heating, camera, calendar and devices show sample data.";
  $("#token").value = store.get("token");
  $("#save-token").addEventListener("click", () => {
    store.set("token", $("#token").value.trim());
    toast("Saved");
    loadAll();
  });

  document.addEventListener("click", (e) => {
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
    if (LIVE && currentTab === "home" && document.visibilityState === "visible") guard("camera");
  }, CONFIG.cameraRefreshSeconds * 1000);

  showTab(["home", "devices", "settings"].includes(store.get("tab")) ? store.get("tab") : "home");

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

init();
