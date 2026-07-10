# Sign Safari - Ann Arbor Summer Game 2026 Route and Explore Map

**Live at https://nickstrayer.me/sign-safari/** (GitHub Pages, deployed by
the `Deploy to GitHub Pages` workflow on every push to `main`).

A static web app for exploring AADL Summer Game 2026 lawn signs and business
code locations, with address/GPS search and personal "seen it" tracking stored
in localStorage. Each location's card also takes its code word; the
progress panel's "Copy code list" button exports all collected codes for
redeeming at play.aadl.org. No backend server.

Route plans walking routes along real streets: start from your location, a
searched address, or any tapped route stop, pick a distance or stop-count
budget, and it greedily collects nearby lawn signs and business-code
locations, then 2-opts the visiting order (`app/src/route.ts`, all
client-side over the prebuilt street network in
`app/public/data/network.json`). Explore is the free-form map for browsing,
searching, tracking, and finding density with its optional heatmap. Routes
export as GPX (waypoints per stop + the full track) for Garmin/Apple
Watch/Strava.

## Layout

- `app/` - the source: a Vite + TypeScript project (strict, no framework;
  Tailwind v4 for the UI chrome, hand CSS for the brand treatment, canvas
  views, and MapLibre overrides). Data files live in `app/public/data/`.
- `docs/` - gitignored build output (`npm run build` empties and regenerates
  it). CI builds its own copy; the local one is only for previewing.
- `scripts/` - the Python data pipeline (below).

## Develop

```sh
cd app
npm install
npm run dev        # http://localhost:5173, HMR
```

## Build & deploy

```sh
cd app
npm run build      # typechecks (tsc --noEmit), then rebuilds docs/
```

Pushing to `main` is the whole deploy: `.github/workflows/deploy.yml` builds
the app and publishes it to GitHub Pages (watch it with `gh run watch`).
Building locally is only for previewing the exact production build:
`npm run preview`, or serve the repo root (`python3 -m http.server 8000`) and
open http://localhost:8000/docs/ to also exercise the subpath resolution that
GitHub Pages uses at `/sign-safari/`. (Must be served over http, not opened
as a file; localhost counts as a secure context, which the geolocate button
requires.)

## Refresh the location data

1. Fetch the latest feed (public endpoint, no AADL login required):

   ```sh
   python3 scripts/fetch_data.py
   ```

   Writes `summer_game_2026_raw.json` in the repo root from
   https://aadl.org/summergame/map/data/SummerGame2026.

2. Convert to GeoJSON:

   ```sh
   python3 scripts/prepare_data.py
   ```

   It rewrites `app/public/data/signs.json`, `biz.json`, and `badges.json`,
   prints kept/dropped counts, and stamps the files with a `generated` date
   shown in the app's progress panel.

3. Rebuild the route planner's street network (needs the Python env in
   `.venv`; see `sign_network.qmd` for the underlying approach):

   ```sh
   .venv/bin/python scripts/build_network.py
   ```

   It downloads the OpenStreetMap walking network (cached in `cache/`),
   splits street edges at each lawn sign or business-code location's closest
   point on the road, preserves
   their OSM road shapes for map and GPX rendering, and writes
   `app/public/data/network.json` (~1.7 MB, ~560 KB gzipped). Locations
   outside the Ann Arbor/Ypsilanti core bbox are left out of the route
   planner.

4. Commit the refreshed `app/public/data/` files (and
   `summer_game_2026_raw.json` if you want the snapshot in git) and push;
   the deploy workflow bundles them into the published build.

## Notes

- Basemap: OpenFreeMap Positron (keyless). A CARTO fallback style URL is in
  `app/src/map.ts`.
- Place search: Photon (komoot.io), biased to the Ann Arbor area. Published
  location addresses are searched locally and work offline.
- Seen progress lives only in the browser's localStorage. iOS Safari can evict
  it after ~7 days of not visiting; the progress panel has copy/paste backup
  buttons for that reason.
- The sign locations are the same data AADL publishes on its own public
  Summer Game map; this app adds nothing beyond it.
