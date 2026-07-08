import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";

import { dataUrl } from "./data";
import { el } from "./dom";
import { isMySignId } from "./ids";
import { createStore, type Settings } from "./store";
import { createSignMap } from "./map";
import { createSearch } from "./search";
import { createUi, createWelcome, type SignIndexEntry, type Ui } from "./ui";
import { createRoutePlanner, hasSavedWalk } from "./route";
import type { Kind, LonLat, SignCollection } from "./types";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

async function main(): Promise<void> {
  const store = createStore();
  // Before the data fetch, so a first visit greets immediately.
  const welcome = createWelcome(store);

  const [signs, biz, badges] = await Promise.all([
    fetchJson<SignCollection>(dataUrl("signs.json")),
    fetchJson<SignCollection>(dataUrl("biz.json")),
    fetchJson<SignCollection>(dataUrl("badges.json")),
  ]);

  const collections: { fc: SignCollection; kind: Kind }[] = [
    { fc: signs, kind: "sign" },
    { fc: biz, kind: "biz" },
  ];

  // Quick lookup for the seen list + search index.
  const signIndexById = new Map<string, SignIndexEntry>();
  for (const { fc, kind } of collections) {
    for (const f of fc.features) {
      const p = f.properties;
      signIndexById.set(p.id, {
        label: p.addr ?? "",
        kind,
        coords: f.geometry.coordinates,
        props: p,
      });
    }
  }

  let ui: Ui; // assigned below; map tap handlers close over it

  const signMap = createSignMap({
    container: "map",
    onFeatureTap(feature) {
      ui.openSheet(feature);
    },
    onMapTap() {
      ui.closeSheet();
    },
    onAddSignTap() {
      startAddSign();
    },
  });

  // Keeps the map source and the seen-list index in step with the
  // user-placed signs in the store.
  function syncMySigns(): void {
    const mine = store.mySigns();
    for (const id of signIndexById.keys()) {
      if (isMySignId(id) && !mine.some((s) => s.id === id)) signIndexById.delete(id);
    }
    for (const s of mine) {
      signIndexById.set(s.id, { label: "Added by you", kind: "sign", coords: s.coords, props: { id: s.id } });
    }
    signMap.setMySigns(mine);
  }

  // "Add a missing sign": geolocate (fall back to the map center), then let
  // the user fine-tune a draggable pin before committing.
  const pinBar = el("pinBar");

  function startAddSign(): void {
    if (!pinBar.hidden) return;
    const begin = (coords: LonLat): void => {
      signMap.flyTo(coords, 17);
      signMap.showPin(coords);
      pinBar.hidden = false;
    };
    if (!navigator.geolocation) {
      begin(signMap.center());
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const here: LonLat = [pos.coords.longitude, pos.coords.latitude];
        begin(signMap.inBounds(here) ? here : signMap.center());
      },
      () => begin(signMap.center()),
      { enableHighAccuracy: true, timeout: 6000 }
    );
  }

  function endPlacement(): void {
    pinBar.hidden = true;
    signMap.hidePin();
  }

  el("pinCancel").addEventListener("click", endPlacement);
  el("pinConfirm").addEventListener("click", () => {
    const coords = signMap.pinPosition();
    const id = store.addMySign(coords);
    endPlacement();
    ui.openSheet({ id, kind: "sign", props: { id }, coords });
    ui.showToast("Sign added - type in its code word!");
  });

  ui = createUi({
    store,
    totalTrackable: signs.features.length + biz.features.length,
    signIndexById,
    onFlyTo: (coords) => signMap.flyTo(coords),
    welcome,
  });
  ui.setDataStamp(signs.generated);
  syncMySigns(); // index entries only; the map source fills in on load

  const searchBox = document.querySelector<HTMLElement>(".search-box");
  if (!searchBox) throw new Error("Missing .search-box");
  const search = createSearch({
    input: el<HTMLInputElement>("searchInput"),
    clearBtn: el("searchClear"),
    resultsEl: el("searchResults"),
    wrapEl: searchBox,
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
  search.buildIndex(collections);

  // Route planner tab. The street network only loads when first opened.
  const routePlanner = createRoutePlanner({ store, showToast: (msg) => ui.showToast(msg) });
  const viewBtns = document.querySelectorAll<HTMLButtonElement>(".view-btn");
  function setView(view: string | undefined): void {
    document.body.classList.toggle("route-mode", view === "route");
    for (const b of viewBtns) b.classList.toggle("is-active", b.dataset.view === view);
    if (view === "route") {
      ui.closeSheet();
      endPlacement();
      routePlanner.show();
    } else {
      routePlanner.hide();
    }
  }
  for (const b of viewBtns) b.addEventListener("click", () => setView(b.dataset.view));
  // A shared route link (#r=...) or an unfinished walkthrough opens
  // straight into the route view.
  if (new URLSearchParams(location.hash.slice(1)).has("r") || hasSavedWalk()) setView("route");

  signMap.onLoad(() => {
    signMap.addLayers({ signs, biz, badges });
    signMap.applySeen(store.seenIds());
    syncMySigns();

    const applySettings = (s: Settings): void => {
      signMap.setLayerVisible("biz-pts", s.showBiz);
      signMap.setLayerVisible("badge-pts", s.showBadges);
      signMap.setHideSeen(s.hideSeen, store.seenIds());
    };
    applySettings(store.settings());
    store.onSettingsChange(applySettings);

    store.onSeenChange((id, isSeen) => {
      if (isMySignId(id)) syncMySigns();
      signMap.setSeen(id, isSeen);
      if (store.settings().hideSeen) signMap.setHideSeen(true, store.seenIds());
    });
  });
}

main().catch((err: unknown) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "beforeend",
    '<div style="position:fixed;inset:0;display:grid;place-items:center;background:#fff8ee;z-index:99;font-family:sans-serif;padding:24px;text-align:center;">Could not load sign data. Check your connection and refresh.</div>'
  );
});
