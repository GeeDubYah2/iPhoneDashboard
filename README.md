# iPhone Dashboard

A personal web dashboard that installs on an iPhone home screen. Plain HTML, CSS and JavaScript, no build step.

## Put it on your phone

1. Upload every file in this folder to the root of the repo.
2. On GitHub: **Settings → Pages → Build and deploy → Deploy from a branch → `main` / `(root)`**.
3. After a minute the site is live at `https://<your-username>.github.io/iPhoneDashboard/`.
4. Open that address in **Safari**, tap **Share → Add to Home Screen**.

GitHub Pages on a free account needs a public repo, so never put passwords, tokens or API keys in these files.

## What works today

| Card | Status |
| --- | --- |
| Weather | Live. Uses Open-Meteo (no key needed). Uses the phone's location; your fallback town is set in the Settings tab. |
| Trains | Live, via an unofficial community National Rail proxy (Huxley2). Your two stations, switch hour and operator are set in the Settings tab, so none of it is stored in the repo. |
| Camera (Ring), Smart devices (Tuya) | Demo data until you connect an API (below). Heating and calendar are switched off for now. |

## Connecting the rest

These services can't be called safely straight from a web page, because they need secret credentials and block browser requests. They need a small API that you host, and you point the dashboard at it by setting `apiBase` in `app.js`.

The dashboard expects these endpoints (HTTPS, with `Authorization: Bearer <token>` and CORS allowing your Pages address):

| Endpoint | Returns / accepts |
| --- | --- |
| `GET /hive/status` | `{ "current": 19.5, "target": 20, "heating": false }` |
| `POST /hive/target` | `{ "target": 21 }` |
| `GET /ring/snapshot` | a JPEG image |
| `GET /calendar` | `[{ "title": "…", "start": "ISO date", "allDay": false }]` |
| `GET /tuya/devices` | `[{ "id": "…", "name": "…", "on": true }]` |
| `POST /tuya/devices/:id` | `{ "on": true }` |

Enter the token once under the **Settings** tab on your phone. It's stored only in that browser.

Notes on the integrations (check current status before relying on them):

- **Tuya** has an official Cloud API.
- **Hive and Ring** don't have official public APIs for personal use, as far as I know. Community libraries exist, and they usually run on a small always-on server.
- **Calendar** can come from the Google Calendar API or a private iCal feed.
