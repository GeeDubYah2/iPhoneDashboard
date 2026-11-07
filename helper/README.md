# Ring helper

A small service that runs on a home PC, signs in to Ring and serves camera snapshots to the dashboard. Ring has no official API, so this uses the community library [`ring-client-api`](https://github.com/dgreif/ring), which can break when Ring changes things.

Your Ring login, refresh token and access token live only in `.env` and `ring-token.json` on the PC. Both are git-ignored. Never commit them.

## Setup (Windows)

1. Install Node.js LTS (version 20.6 or newer).
2. In this folder, run `npm install`.
3. Run `npm run auth` and sign in with your Ring email, password and two-factor code. It prints a refresh token.
4. Copy `.env.example` to `.env`. Paste the refresh token, and set `DASHBOARD_TOKEN` to a long random string.
5. Run `npm start`. It listens on `http://127.0.0.1:8787`, on this PC only.
6. Give it a public HTTPS address with a tunnel (for example Tailscale Funnel or Cloudflare Tunnel) that points to `http://127.0.0.1:8787`.
7. On the phone, open the dashboard: **Settings → Ring cameras**. Enter the tunnel address and the `DASHBOARD_TOKEN`, then tap Save.

## Start automatically when you log in

`start-helper.ps1` runs the helper, writes its output to `logs\helper.log` (git-ignored), and restarts it 15 seconds after it stops. A Windows scheduled task named **Dashboard Ring helper** runs the script, hidden, 30 seconds after you log in. It needs no administrator rights.

- Start or stop it now: `Start-ScheduledTask "Dashboard Ring helper"` / `Stop-ScheduledTask "Dashboard Ring helper"`
- Remove it: `Unregister-ScheduledTask "Dashboard Ring helper"`

## Train alerts (push notifications)

The helper also sends the phone a notification 10 minutes before the train you're on reaches your station. On the phone: open the dashboard from the Home Screen, tap 🔔 beside a station in **Settings → Trains**, and mark your train with the circle on the Trains card. **Settings → Notifications → Test notifications** sends a test 5 seconds later.

Push uses Web Push with VAPID, built on Node's own crypto (`push.js`, no extra packages). The helper's VAPID keys are in `vapid.json`, and phone subscriptions and the watched train are in `push-state.json`. Both are git-ignored. Delete `vapid.json` to make new keys, then turn the bells off and on again on the phone. Set `ALERT_MINUTES` in `.env` to change the 10 minutes.

## Sonos volume

The Sonos card on the dashboard's Home tab uses the helper too. Sonos speakers answer simple requests on port 1400 of your home network with no login, so the helper (`sonos.js`, no extra packages) finds them with a network search and sets each room's volume and mute. It can also group rooms so one plays along with another (like "Group" in the Sonos app) and ungroup them again, and fade out whatever is playing: every playing room goes down by a tenth of its volume every 3 seconds, reaching zero after 30 seconds, then the music pauses and the volumes go back to where they were. The fade runs on the PC, so it carries on when the phone is locked. The card also shows what each room is playing, with the artwork, and has play/pause, skip, shuffle and repeat buttons and a TV button (for a room with a soundbar). Shuffle and repeat only work for music chosen in the Sonos app; music played from another app (like Spotify Connect) can be paused and skipped but not shuffled. Nothing needs setting up: it uses the same helper address and token as the Ring cameras.

If no speakers are found (a firewall can block the search), set `SONOS_HOSTS` in `.env` to one or more speaker IP addresses, separated by commas. The Sonos app shows them under **Settings → System → About My System**.

## Endpoints

| Endpoint | Returns |
| --- | --- |
| `GET /health` | `{ "ok": true, "uptime": 120 }` (for the status light; doesn't contact Ring) |
| `GET /ring/cameras` | `[{ "id": "…", "name": "…", "offline": false, "battery": 80 }]` |
| `GET /ring/cameras/:id/snapshot` | a JPEG image |
| `GET /push/key` | `{ "publicKey": "…" }` (VAPID key for the phone to subscribe) |
| `POST /push/subscribe` | the phone's push subscription |
| `POST /push/watch` | `{ "id", "crs", "station", "std" }`: alert 10 minutes before the train reaches `crs` |
| `POST /push/unwatch` | stop watching |
| `POST /push/test` | `{ "delaySeconds": 5 }`: send a test notification |
| `GET /sonos/rooms` | `[{ "id": "RINCON_…", "name": "Kitchen", "group": "RINCON_…", "fadeLeft": null, "volume": 30, "muted": false }]` (`group` is the room leading its group; `fadeLeft` is the seconds left of a fade, or `null`; `playing` is `{ "state", "title", "artist", "album", "artKey" }` or `null`; `tv` is true for a room with a TV input; `controls` is `{ "state", "shuffle", "repeat", "canPlay", "canSkip", "canShuffle", "tv" }` for the room's group) |
| `GET /sonos/art/:id` | the artwork for what room `id`'s group is playing (`id` is the room leading the group) |
| `POST /sonos/volume` | `{ "id", "volume" }`: set a room's volume (0 to 100) |
| `POST /sonos/mute` | `{ "id", "muted" }`: mute or unmute a room |
| `POST /sonos/join` | `{ "id", "to" }`: room `id` plays the same music as room `to` |
| `POST /sonos/leave` | `{ "id" }`: room `id` leaves its group |
| `POST /sonos/fade` | fade out every playing room over 30 seconds, then pause (`409` if nothing is playing) |
| `POST /sonos/fade/stop` | stop the fade; the volume stays where it is |
| `POST /sonos/control` | `{ "id", "action" }`: `play`, `pause`, `next`, `previous`, `shuffle` (on/off), `repeat` (off → all → one) or `tv` (switch room `id` to the TV) |

Every request needs `Authorization: Bearer <DASHBOARD_TOKEN>`. Snapshots are cached for 30 seconds. Battery cameras may not have a fresh snapshot every time.
