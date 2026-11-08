# To do

Work still to do on the dashboard. Tick items off (`[x]`) or delete them when they're done. This repo is public, so keep personal details out of this file.

## Next up

- [ ] Update the main README. It still says Ring is demo data and that everything needs an `apiBase` backend; the home helper now handles Ring cameras, Sonos and train alerts.
- [ ] Connect the Smart devices card (Tuya) through the home helper, using Tuya's official Cloud API. It shows demo devices for now.

## Later

- [ ] Bring back the Heating card (Hive) through the home helper. Hive has no official public API, so this needs a community library.
- [ ] Bring back the Calendar card, from a private iCal feed or the Google Calendar API. Both cards are switched off in `loadAll()` in `app.js` and need their cards adding back to `index.html`.
- [ ] Decide whether to drop `apiBase` and the old backend endpoint list, and send everything through the home helper instead.
- [ ] Trains rely on an unofficial community proxy (Huxley2). Consider a fallback if it goes down.

## Tidy-up

- [ ] Remove `rename.ps1` if the `*_js.txt` rename habit is no longer needed.

## Ideas

- 
