// Sonos volume control over the home network.
// Sonos speakers answer UPnP (SOAP) requests on port 1400 with no login, so this
// only works from a PC on the same network. Uses Node's own modules, no packages.
//
// Speakers are found with SSDP (a multicast search). If that's blocked (for
// example by a firewall), set SONOS_HOSTS in .env to one or more speaker IPs.

import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { createHash } from "node:crypto";

const SSDP_SEARCH = [
  "M-SEARCH * HTTP/1.1",
  "HOST: 239.255.255.250:1900",
  'MAN: "ssdp:discover"',
  "MX: 1",
  "ST: urn:schemas-upnp-org:device:ZonePlayer:1",
  "", "",
].join("\r\n");

// Sends an SSDP search from every network adapter and collects Sonos IPs for ~2.5 s.
function discover() {
  const addresses = Object.values(networkInterfaces()).flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a.address);
  const found = new Set();
  return new Promise((resolve) => {
    const sockets = addresses.map((address) => {
      const s = createSocket({ type: "udp4", reuseAddr: true });
      s.on("error", () => s.close());
      s.on("message", (msg, rinfo) => {
        const text = msg.toString();
        if (/sonos/i.test(text) && /:1400\//.test(text)) found.add(rinfo.address);
      });
      s.bind(0, address, () => {
        const buf = Buffer.from(SSDP_SEARCH);
        s.send(buf, 1900, "239.255.255.250");
        setTimeout(() => { try { s.send(buf, 1900, "239.255.255.250"); } catch { /* closed */ } }, 500);
      });
      return s;
    });
    setTimeout(() => {
      sockets.forEach((s) => { try { s.close(); } catch { /* already closed */ } });
      resolve([...found]);
    }, 2500);
  });
}

const xmlUnescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

async function soap(ip, path, service, action, args = "") {
  const res = await fetch(`http://${ip}:1400${path}`, {
    method: "POST",
    headers: {
      "Content-Type": 'text/xml; charset="utf-8"',
      SOAPACTION: `"urn:schemas-upnp-org:service:${service}:1#${action}"`,
    },
    body: '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      `<s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:${service}:1">${args}</u:${action}></s:Body></s:Envelope>`,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Sonos ${action} failed (${res.status})`);
  return res.text();
}

const rendering = (ip, action, args = "") =>
  soap(ip, "/MediaRenderer/RenderingControl/Control", "RenderingControl", action,
    `<InstanceID>0</InstanceID><Channel>Master</Channel>${args}`);

// Asks one speaker for the whole system's rooms and how they're grouped.
// Stereo pairs, subs and surrounds are hidden members, so each room appears once.
// "group" is the ID of the room leading its group (its own ID when it's on its own).
async function roomsFrom(ip) {
  const xml = await soap(ip, "/ZoneGroupTopology/Control", "ZoneGroupTopology", "GetZoneGroupState");
  const state = xmlUnescape(xml.match(/<ZoneGroupState>([\s\S]*)<\/ZoneGroupState>/)?.[1] || "");
  const rooms = [];
  for (const [, groupAttrs, members] of state.matchAll(/<ZoneGroup(\s[^>]*)>([\s\S]*?)<\/ZoneGroup>/g)) {
    const group = attr(groupAttrs, "Coordinator");
    for (const tag of members.match(/<ZoneGroupMember\s[^>]*>/g) || []) {
      if (attr(tag, "Invisible") === "1" || attr(tag, "IsZoneBridge") === "1") continue;
      const host = attr(tag, "Location")?.match(/^http:\/\/([\d.]+):1400\//)?.[1];
      const id = attr(tag, "UUID");
      if (host && id) rooms.push({ id, name: xmlUnescape(attr(tag, "ZoneName") || "Sonos"), host, group: group || id });
    }
  }
  return rooms;
}

// Fallback for systems that don't answer GetZoneGroupState: one room per speaker.
async function roomFromDescription(ip) {
  const res = await fetch(`http://${ip}:1400/xml/device_description.xml`, { signal: AbortSignal.timeout(5000) });
  const xml = await res.text();
  const id = xml.match(/<UDN>uuid:([^<]+)<\/UDN>/)?.[1];
  const name = xml.match(/<roomName>([^<]*)<\/roomName>/)?.[1];
  return id ? { id, name: xmlUnescape(name || "Sonos"), host: ip, group: id } : null;
}

// Speaker addresses are found once and reused; who's grouped with whom is
// read fresh every time, since it changes whenever someone uses the Sonos app.
const IPS_CACHE_SECONDS = 300;
let speakers = { at: 0, ips: [] };
let lastRooms = [];

async function speakerIps(fresh) {
  if (!fresh && speakers.ips.length && Date.now() - speakers.at < IPS_CACHE_SECONDS * 1000) return speakers.ips;
  const fixed = (process.env.SONOS_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ips = fixed.length ? fixed : await discover();
  if (!ips.length) throw new Error("no Sonos speakers found on the network");
  speakers = { at: Date.now(), ips };
  return ips;
}

async function topology(fresh = false) {
  const ips = await speakerIps(fresh);
  let rooms = [];
  for (const ip of ips) {
    try { rooms = await roomsFrom(ip); } catch { /* try the next speaker */ }
    if (rooms.length) break;
  }
  if (!rooms.length) rooms = (await Promise.all(ips.map((ip) => roomFromDescription(ip).catch(() => null)))).filter(Boolean);
  if (!rooms.length) throw new Error("Sonos speakers didn't answer");
  rooms.sort((a, b) => a.name.localeCompare(b.name));
  lastRooms = rooms;
  return rooms;
}

// If no speaker answers, a speaker may have a new address; search again once.
const getRoomList = () => topology().catch(() => topology(true));

// Only rooms the helper found itself can be controlled (never an address from the request).
async function roomById(id) {
  id = String(id || "");
  const room = lastRooms.find((r) => r.id === id) || (await getRoomList()).find((r) => r.id === id);
  if (!room) throw Object.assign(new Error("no such Sonos room"), { status: 404 });
  return room;
}

async function readRoom(room) {
  const [v, m] = await Promise.all([rendering(room.host, "GetVolume"), rendering(room.host, "GetMute")]);
  return {
    id: room.id,
    name: room.name,
    group: room.group,
    fadeLeft: fadeLeft(room.id),
    volume: Number(v.match(/<CurrentVolume>(\d+)<\/CurrentVolume>/)?.[1] ?? 0),
    muted: m.match(/<CurrentMute>(\d)<\/CurrentMute>/)?.[1] === "1",
  };
}

// What a group is playing: { state: "playing" | "paused", title, artist, album, art } or null.
// "art" is the artwork's address as the speaker gave it (kept here; the phone gets it through /sonos/art).
async function nowPlaying(host) {
  const [t, p, m] = await Promise.all(["GetTransportInfo", "GetPositionInfo", "GetMediaInfo"].map((a) => transport(host, a)));
  const state = t.match(/<CurrentTransportState>([^<]*)/)?.[1] || "";
  if (!/^(PLAYING|TRANSITIONING|PAUSED_PLAYBACK)$/.test(state)) return null;
  const meta = xmlUnescape(p.match(/<TrackMetaData>([\s\S]*?)<\/TrackMetaData>/)?.[1] || "");
  const media = xmlUnescape(m.match(/<CurrentURIMetaData>([\s\S]*?)<\/CurrentURIMetaData>/)?.[1] || "");
  const tag = (xml, name) => xmlUnescape(xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`))?.[1] || "").trim();
  const uri = xmlUnescape(p.match(/<TrackURI>([^<]*)/)?.[1] || "");
  let title = tag(meta, "dc:title");
  let artist = tag(meta, "dc:creator");
  let album = tag(meta, "upnp:album");
  const stream = tag(meta, "r:streamContent"); // radio: usually "Artist - Song"
  const source = tag(media, "dc:title"); // radio station or playlist name
  if (uri.startsWith("x-sonos-htastream:")) { title = "TV"; artist = ""; album = ""; }
  else if (uri.startsWith("x-rincon-stream:")) { title = "Line-in"; artist = ""; album = ""; }
  else if (stream) {
    const [a, ...rest] = stream.split(" - ");
    if (rest.length) { artist = a; title = rest.join(" - "); } else title = stream;
    album = source || album;
  }
  if ((!title || /^(x-|https?:)|\.(mp3|aac|m3u8?)$/i.test(title)) && source) title = source; // not a real title
  if (!title) return null;
  const art = tag(meta, "upnp:albumArtURI");
  return {
    state: state === "PAUSED_PLAYBACK" ? "paused" : "playing",
    title, artist, album,
    art: art ? new URL(art, `http://${host}:1400`).href : "",
  };
}

// Shuffle and repeat, as Sonos names their combinations.
const PLAY_MODES = {
  NORMAL: [false, "off"], REPEAT_ALL: [false, "all"], REPEAT_ONE: [false, "one"],
  SHUFFLE_NOREPEAT: [true, "off"], SHUFFLE: [true, "all"], SHUFFLE_REPEAT_ONE: [true, "one"],
};
const playModeFor = (shuffle, repeat) =>
  Object.keys(PLAY_MODES).find((k) => PLAY_MODES[k][0] === shuffle && PLAY_MODES[k][1] === repeat);

// What the buttons can do for a group, from the room leading it:
// { state, shuffle, repeat, canPlay, canSkip, canShuffle, tv }.
async function groupControls(host) {
  const [t, s, m] = await Promise.all(["GetTransportInfo", "GetTransportSettings", "GetMediaInfo"].map((a) => transport(host, a)));
  const raw = t.match(/<CurrentTransportState>([^<]*)/)?.[1] || "";
  const [shuffle, repeat] = PLAY_MODES[s.match(/<PlayMode>([^<]*)/)?.[1]] || [false, "off"];
  const uri = xmlUnescape(m.match(/<CurrentURI>([^<]*)/)?.[1] || "");
  const queue = uri.startsWith("x-rincon-queue:"); // the Sonos queue (music chosen in the Sonos app)
  const connect = uri.startsWith("x-sonos-vli:"); // played from another app, e.g. Spotify Connect or AirPlay
  return {
    state: /^(PLAYING|TRANSITIONING)$/.test(raw) ? "playing" : raw === "PAUSED_PLAYBACK" ? "paused" : "stopped",
    shuffle, repeat,
    canPlay: Boolean(uri),
    canSkip: queue || connect,
    canShuffle: queue,
    tv: uri.startsWith("x-sonos-htastream:"),
  };
}

// Rooms with a TV input (soundbars), by room ID. Read once from each speaker's description.
const hasTv = new Map();
async function checkTv(room) {
  if (!hasTv.has(room.id)) {
    try {
      const res = await fetch(`http://${room.host}:1400/xml/device_description.xml`, { signal: AbortSignal.timeout(5000) });
      hasTv.set(room.id, (await res.text()).includes("urn:schemas-upnp-org:service:HTControl:1"));
    } catch { return false; }
  }
  return hasTv.get(room.id);
}

// Artwork addresses the speakers reported, by the room leading the group.
// The art endpoint only ever fetches one of these, never an address from the request.
const artByLead = new Map();

// [{ id, name, group, fadeLeft, volume, muted, tv, playing, controls }]; a speaker that doesn't answer is left out.
// "tv" is true for a room with a TV input. "playing" is { state, title, artist, album, artKey } for the
// room's group, or null. "controls" is what the play buttons can do for the room's group (see groupControls).
export async function sonosRooms() {
  let rooms = await getRoomList();
  let read = await Promise.all(rooms.map((r) => readRoom(r).catch(() => null)));
  if (read.some((r) => !r)) { // a speaker may have a new IP; look again once
    rooms = await topology(true);
    read = await Promise.all(rooms.map((r) => readRoom(r).catch(() => null)));
  }
  const leadOf = (r) => (rooms.some((x) => x.id === r.group) ? r.group : r.id);
  const leads = [...new Set(rooms.map(leadOf))];
  const now = new Map(await Promise.all(leads.map(async (lead) =>
    [lead, await nowPlaying(rooms.find((r) => r.id === lead).host).catch(() => null)])));
  const controls = new Map(await Promise.all(leads.map(async (lead) =>
    [lead, await groupControls(rooms.find((r) => r.id === lead).host).catch(() => null)])));
  const tv = new Map(await Promise.all(rooms.map(async (r) => [r.id, await checkTv(r)])));
  artByLead.clear();
  for (const [lead, np] of now) if (np?.art) artByLead.set(lead, np.art);
  return read.filter(Boolean).map((r) => {
    const np = now.get(leadOf(r));
    const { art, ...rest } = np || {};
    return {
      ...r,
      tv: tv.get(r.id) || false,
      playing: np ? { ...rest, artKey: art ? createHash("sha1").update(art).digest("hex").slice(0, 12) : null } : null,
      controls: controls.get(leadOf(r)) || null,
    };
  });
}

// The artwork for what the group led by "id" is playing: { type, body } or null.
export async function sonosArt(id) {
  const url = artByLead.get(String(id || ""));
  if (!url) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const type = res.headers.get("content-type") || "";
  if (!res.ok || !type.startsWith("image/")) return null;
  const body = Buffer.from(await res.arrayBuffer());
  return body.length <= 5 * 1024 * 1024 ? { type, body } : null;
}

export async function sonosSetVolume(id, volume) {
  const room = await roomById(id);
  if (fade) fade.rooms = fade.rooms.filter((r) => r.id !== room.id); // you've taken over this room
  const v = Math.max(0, Math.min(100, Math.round(Number(volume))));
  if (!Number.isFinite(v)) throw Object.assign(new Error("volume must be 0 to 100"), { status: 400 });
  await rendering(room.host, "SetVolume", `<DesiredVolume>${v}</DesiredVolume>`);
  return { id: room.id, volume: v };
}

export async function sonosSetMute(id, muted) {
  const room = await roomById(id);
  await rendering(room.host, "SetMute", `<DesiredMute>${muted ? 1 : 0}</DesiredMute>`);
  return { id: room.id, muted: Boolean(muted) };
}

const transport = (ip, action, args = "") =>
  soap(ip, "/MediaRenderer/AVTransport/Control", "AVTransport", action, `<InstanceID>0</InstanceID>${args}`);

// Room "id" joins the group "to" is in and plays the same music, in sync
// (what "Group" does in the Sonos app).
export async function sonosJoin(id, to) {
  await getRoomList(); // the latest grouping
  const room = await roomById(id);
  const target = await roomById(to);
  const leader = lastRooms.find((r) => r.id === target.group) || target;
  if (leader.id === room.id) throw Object.assign(new Error("a room can't join its own group"), { status: 400 });
  await transport(room.host, "SetAVTransportURI",
    `<CurrentURI>x-rincon:${leader.id}</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>`);
  return { id: room.id, group: leader.id };
}

// Room "id" leaves its group and goes back to playing on its own. If it was
// leading the group, the others keep playing together.
export async function sonosLeave(id) {
  const room = await roomById(id);
  await transport(room.host, "BecomeCoordinatorOfStandaloneGroup");
  return { id: room.id, group: room.id };
}

// ---------------------------- Fade out ----------------------------
// Turns every playing room down by a tenth of its starting volume every
// 3 seconds (30 seconds in all). At zero it pauses the music and puts the volumes back, so the
// next time you press play it isn't silent. Runs here, so it carries on when
// the phone is locked.

const FADE_STEPS = 10;
const FADE_STEP_SECONDS = 3; // 10 steps: silent after 30 seconds
let fade = null; // { timer, step, rooms: [{ id, host, lead, start }] }

const isPlaying = async (host) =>
  /<CurrentTransportState>(PLAYING|TRANSITIONING)<\/CurrentTransportState>/.test(await transport(host, "GetTransportInfo"));

// Seconds until the fade finishes for this room, or null when it isn't fading.
function fadeLeft(id) {
  if (!fade || !fade.rooms.some((r) => r.id === id)) return null;
  return (FADE_STEPS - fade.step) * FADE_STEP_SECONDS;
}

async function fadeStep() {
  const f = fade;
  if (!f) return;
  f.step++;
  if (f.step < FADE_STEPS) {
    await Promise.all(f.rooms.map((r) =>
      rendering(r.host, "SetVolume", `<DesiredVolume>${Math.round(r.start * (1 - f.step / FADE_STEPS))}</DesiredVolume>`).catch(() => {})));
    return;
  }
  clearInterval(f.timer);
  fade = null;
  await Promise.all(f.rooms.map((r) => rendering(r.host, "SetVolume", "<DesiredVolume>0</DesiredVolume>").catch(() => {})));
  // Pause each group, then put back the volume only where the pause worked
  // (never turn music back up that's still playing).
  const leads = [...new Set(f.rooms.map((r) => r.lead))];
  const paused = new Set();
  await Promise.all(leads.map(async (lead) => {
    const host = lastRooms.find((r) => r.id === lead)?.host;
    if (!host) return;
    try { await transport(host, "Pause"); paused.add(lead); } catch (e) { console.error(new Date().toISOString(), "sonos fade pause", e.message); }
  }));
  await new Promise((done) => setTimeout(done, 1000));
  await Promise.all(f.rooms.filter((r) => paused.has(r.lead)).map((r) =>
    rendering(r.host, "SetVolume", `<DesiredVolume>${r.start}</DesiredVolume>`).catch(() => {})));
}

export async function sonosFade() {
  if (fade) return { fading: true, seconds: (FADE_STEPS - fade.step) * FADE_STEP_SECONDS };
  const rooms = await getRoomList();
  const lead = (r) => (rooms.some((x) => x.id === r.group) ? r.group : r.id);
  const leads = [...new Set(rooms.map(lead))];
  const playing = new Set();
  await Promise.all(leads.map(async (id) => {
    try { if (await isPlaying(rooms.find((r) => r.id === id).host)) playing.add(id); } catch { /* not answering */ }
  }));
  const fading = rooms.filter((r) => playing.has(lead(r)));
  if (!fading.length) throw Object.assign(new Error("nothing is playing"), { status: 409 });
  const read = await Promise.all(fading.map(readRoom));
  fade = {
    step: 0,
    rooms: fading.map((r, i) => ({ id: r.id, host: r.host, lead: lead(r), start: read[i].volume })),
  };
  fade.timer = setInterval(() => fadeStep().catch((e) => console.error(new Date().toISOString(), "sonos fade", e.message)), FADE_STEP_SECONDS * 1000);
  return { fading: true, seconds: (FADE_STEPS - fade.step) * FADE_STEP_SECONDS, rooms: fade.rooms.map((r) => r.id) };
}

// Stops the fade and leaves the volume where it's got to.
export function sonosStopFade() {
  if (fade) clearInterval(fade.timer);
  fade = null;
  return { fading: false };
}

// ------------------------- Play buttons and TV -------------------------
// action: play, pause, next, previous, shuffle (on/off), repeat (off -> all -> one -> off)
// or tv (switch a room with a TV input to the TV sound). Playback actions go to
// the room leading the group, so they work from any room in it.
export async function sonosControl(id, action) {
  await getRoomList(); // the latest grouping
  const room = await roomById(id);
  const lead = lastRooms.find((r) => r.id === room.group) || room;
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  switch (action) {
    case "play": await transport(lead.host, "Play", "<Speed>1</Speed>"); break;
    case "pause": await transport(lead.host, "Pause"); break;
    case "next": await transport(lead.host, "Next"); break;
    case "previous": await transport(lead.host, "Previous"); break;
    case "shuffle":
    case "repeat": {
      const s = await transport(lead.host, "GetTransportSettings");
      let [shuffle, repeat] = PLAY_MODES[s.match(/<PlayMode>([^<]*)/)?.[1]] || [false, "off"];
      if (action === "shuffle") shuffle = !shuffle;
      else repeat = { off: "all", all: "one", one: "off" }[repeat];
      await transport(lead.host, "SetPlayMode", `<NewPlayMode>${playModeFor(shuffle, repeat)}</NewPlayMode>`);
      break;
    }
    case "tv": {
      if (!(await checkTv(room))) throw bad("this room has no TV input");
      await transport(room.host, "SetAVTransportURI",
        `<CurrentURI>x-sonos-htastream:${room.id}:spdif</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>`);
      await transport(room.host, "Play", "<Speed>1</Speed>").catch(() => {}); // the TV may already be playing
      break;
    }
    default: throw bad("unknown action");
  }
  return { ok: true, id: room.id, action };
}
