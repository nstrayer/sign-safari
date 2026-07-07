# Sign Safari - Ann Arbor Summer Game 2026 Sign Map

**Live at https://nickstrayer.me/sign-safari/** (GitHub Pages, `main` branch
`/docs` folder).

A static web app showing a heat map of AADL Summer Game 2026 lawn signs, with
address/GPS search and personal "seen it" tracking stored in localStorage.
Each sign's card also takes the code word printed on the physical sign; the
progress panel's "Copy code list" button exports all collected codes for
redeeming at play.aadl.org. No backend server; everything lives in `docs/`.

The Route tab plans walking routes along real streets: tap a sign to start,
pick a distance or sign-count budget, and it greedily collects nearby signs
and 2-opts the visiting order (`docs/js/route.js`, all client-side over the
prebuilt street network in `docs/data/network.json`).

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

3. Rebuild the route planner's street network (needs the Python env in
   `.venv`; see `sign_network.qmd` for the underlying approach):

   ```sh
   .venv/bin/python scripts/build_network.py
   ```

   It downloads the OpenStreetMap walking network (cached in `cache/`),
   splits street edges at each sign's closest point on the road, and writes
   `docs/data/network.json` (~0.9 MB, ~280 KB gzipped). Signs outside the
   Ann Arbor/Ypsilanti core bbox are left out of the route planner.

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
