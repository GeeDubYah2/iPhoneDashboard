// Sonos volume control over the home network.
// Sonos speakers answer UPnP (SOAP) requests on port 1400 with no login, so this
// only works from a PC on the same network. Uses Node's own modules, no packages.
//
// Speakers are found with SSDP (a multicast search). If that's blocked (for
// example by a firewall), set SONOS_HOSTS in .env to one or more speaker IPs.

import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";

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
    volume: Number(v.match(/<CurrentVolume>(\d+)<\/CurrentVolume>/)?.[1] ?? 0),
    muted: m.match(/<CurrentMute>(\d)<\/CurrentMute>/)?.[1] === "1",
  };
}

// [{ id, name, group, volume, muted }]; a speaker that doesn't answer is left out.
export async function sonosRooms() {
  let rooms = await getRoomList();
  let read = await Promise.all(rooms.map((r) => readRoom(r).catch(() => null)));
  if (read.some((r) => !r)) { // a speaker may have a new IP; look again once
    rooms = await topology(true);
    read = await Promise.all(rooms.map((r) => readRoom(r).catch(() => null)));
  }
  return read.filter(Boolean);
}

export async function sonosSetVolume(id, volume) {
  const room = await roomById(id);
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
