# Sign Safari - Ann Arbor Summer Game 2026 Sign Map

A static web app showing a heat map of AADL Summer Game 2026 lawn signs, with
address/GPS search and personal "seen it" tracking stored in localStorage.
No backend server; everything lives in `docs/`.

## Run locally

```sh
python3 -m http.server 8000 --directory docs
```

Then open http://localhost:8000. (Must be served over http, not opened as a
file, so the app can fetch its data files; localhost also counts as a secure
context, which the geolocate button requires.)

## Refresh the sign data

1. While logged in to aadl.org, download
   https://aadl.org/summergame/map/data/SummerGame2026 and save it as
   `summer_game_2026_raw.json` in the repo root.
2. Rerun the converter:

   ```sh
   python3 scripts/prepare_data.py
   ```

   It rewrites `docs/data/signs.json`, `docs/data/biz.json`, and
   `docs/data/badges.json`, prints kept/dropped counts, and stamps the files
   with a `generated` date shown in the app's progress panel.

## Notes

- Basemap: OpenFreeMap Positron (keyless). A CARTO fallback style URL is in
  `docs/js/map.js`.
- Place search: Photon (komoot.io), biased to the Ann Arbor area. Sign
  addresses are searched locally and work offline.
- Seen progress lives only in the browser's localStorage. iOS Safari can evict
  it after ~7 days of not visiting; the progress panel has copy/paste backup
  buttons for that reason.
- The sign locations are the same data AADL publishes on its own public
  Summer Game map; this app adds nothing beyond it.
