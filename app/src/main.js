import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";

import { createStore } from "./store";
import { createSignMap } from "./map";
import { createSearch } from "./search";
import { createUi, createWelcome } from "./ui";
import { createRoutePlanner } from "./route";

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function main() {
  const store = createStore();
  // Before the data fetch, so a first visit greets immediately.
  const welcome = createWelcome(store);

  const [signs, biz, badges] = await Promise.all([
    fetchJson("./data/signs.json"),
    fetchJson("./data/biz.json"),
    fetchJson("./data/badges.json"),
  ]);

  // Quick lookup for the seen list + search index.
  const signIndexById = new Map();
  for (const { fc, kind } of [
    { fc: signs, kind: "sign" },
    { fc: biz, kind: "biz" },
  ]) {
    for (const f of fc.features) {
      const p = f.properties;
      signIndexById.set(p.id, {
        label: p.addr,
        kind,
        coords: f.geometry.coordinates,
        props: p,
      });
    }
  }

  let ui; // assigned below; map tap handlers close over it

  const signMap = createSignMap({
    container: "map",
    onFeatureTap(feature) {
      ui.openSheet(feature);
    },
    onMapTap() {
      ui.closeSheet();
    },
  });

  ui = createUi({
    store,
    totalTrackable: signs.features.length + biz.features.length,
    signIndexById,
    onFlyTo: (coords) => signMap.flyTo(coords),
    welcome,
  });
  ui.setDataStamp(signs.generated);

  const search = createSearch({
    input: document.getElementById("searchInput"),
    clearBtn: document.getElementById("searchClear"),
    resultsEl: document.getElementById("searchResults"),
    wrapEl: document.querySelector(".search-box"),
    store,
    onPick(item) {
      if (item.kind === "place") {
        signMap.flyTo(item.coords, 16);
      } else {
        signMap.flyTo(item.coords);
        ui.openSheet({ id: item.id, kind: item.kind, props: item.props, coords: item.coords });
      }
    },
  });
  search.buildIndex([
    { fc: signs, kind: "sign" },
    { fc: biz, kind: "biz" },
  ]);

  // Route planner tab. The street network only loads when first opened.
  const routePlanner = createRoutePlanner({ store, showToast: (msg) => ui.showToast(msg) });
  const viewBtns = document.querySelectorAll(".view-btn");
  function setView(view) {
    document.body.classList.toggle("route-mode", view === "route");
    for (const b of viewBtns) b.classList.toggle("is-active", b.dataset.view === view);
    if (view === "route") {
      ui.closeSheet();
      routePlanner.show();
    } else {
      routePlanner.hide();
    }
  }
  for (const b of viewBtns) b.addEventListener("click", () => setView(b.dataset.view));

  signMap.onLoad(() => {
    signMap.addLayers({ signs, biz, badges });
    signMap.applySeen(store.seenIds());

    const applySettings = (s) => {
      signMap.setLayerVisible("biz-pts", s.showBiz);
      signMap.setLayerVisible("badge-pts", s.showBadges);
      signMap.setHideSeen(s.hideSeen, store.seenIds());
    };
    applySettings(store.settings());
    store.onSettingsChange(applySettings);

    store.onSeenChange((id, isSeen) => {
      signMap.setSeen(id, isSeen);
      if (store.settings().hideSeen) signMap.setHideSeen(true, store.seenIds());
    });
  });
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "beforeend",
    '<div style="position:fixed;inset:0;display:grid;place-items:center;background:#fff8ee;z-index:99;font-family:sans-serif;padding:24px;text-align:center;">Could not load sign data. Check your connection and refresh.</div>'
  );
});
