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

## Endpoints

| Endpoint | Returns |
| --- | --- |
| `GET /health` | `{ "ok": true, "uptime": 120 }` (for the status light; doesn't contact Ring) |
| `GET /ring/cameras` | `[{ "id": "…", "name": "…", "offline": false, "battery": 80 }]` |
| `GET /ring/cameras/:id/snapshot` | a JPEG image |

Every request needs `Authorization: Bearer <DASHBOARD_TOKEN>`. Snapshots are cached for 30 seconds. Battery cameras may not have a fresh snapshot every time.
