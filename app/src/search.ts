// Local-first search: instant substring match over sign addresses, with
// Photon (komoot.io) place results appended for anything beyond the dataset.

import { createGeocoder, type GeocodedPlace } from "./geocoder";
import type { Store } from "./store";
import type { Kind, LonLat, SignCollection, SignProps } from "./types";

/** A sign/biz/badge from our own dataset, matched locally. */
interface LocalItem {
  id: string;
  kind: Kind;
  label: string;
  sub: string;
  key: string; // normalized haystack for matching
  coords: LonLat;
  props: SignProps;
}

/** A Photon geocoder hit outside the dataset. */
interface PlaceItem extends GeocodedPlace {
  kind: "place";
}

export type SearchItem = LocalItem | PlaceItem;

interface SearchOptions {
  input: HTMLInputElement;
  clearBtn: HTMLElement;
  resultsEl: HTMLElement;
  wrapEl: HTMLElement;
  store: Store;
  onPick: (item: SearchItem) => void;
}

export interface Search {
  buildIndex(collections: { fc: SignCollection; kind: Kind }[]): void;
  close(): void;
}

function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function createSearch({ input, clearBtn, resultsEl, wrapEl, store, onPick }: SearchOptions): Search {
  let index: LocalItem[] = [];
  const geocoder = createGeocoder({
    limit: 5,
    currentQuery: () => input.value.trim(),
    normalize: norm,
    stateFallback: true,
  });

  function buildIndex(collections: { fc: SignCollection; kind: Kind }[]): void {
    index = [];
    for (const { fc, kind } of collections) {
      for (const f of fc.features) {
        const p = f.properties;
        const label = p.addr || p.label || "";
        if (!label) continue;
        index.push({
          id: p.id,
          kind,
          label,
          sub: [p.city, p.zip].filter(Boolean).join(" "),
          key: norm(`${label} ${p.city ?? ""}`),
          coords: f.geometry.coordinates,
          props: p,
        });
      }
    }
  }

  function localMatches(q: string): LocalItem[] {
    const nq = norm(q);
    const starts: LocalItem[] = [];
    const contains: LocalItem[] = [];
    for (const item of index) {
      if (item.key.startsWith(nq)) starts.push(item);
      else if (item.key.includes(nq)) contains.push(item);
      if (starts.length >= 6) break;
    }
    return [...starts, ...contains].slice(0, 6);
  }

  function render(items: LocalItem[], photonItems: PlaceItem[], q: string): void {
    resultsEl.innerHTML = "";
    if (!items.length && !photonItems.length) {
      if (q.length >= 3) {
        const li = document.createElement("li");
        li.className = "p-3 text-[13.5px] text-[#8c8aa8]";
        li.textContent = "No matches nearby - try a street name or place.";
        resultsEl.appendChild(li);
        resultsEl.hidden = false;
      } else {
        resultsEl.hidden = true;
      }
      return;
    }

    const addGroup = (label: string) => {
      const li = document.createElement("li");
      li.className = "px-3 pt-2 pb-1 text-[10.5px] font-extrabold tracking-[0.8px] text-peri uppercase";
      li.textContent = label;
      resultsEl.appendChild(li);
    };

    const addOption = (item: SearchItem) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.className = "flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2.5 text-[14.5px] font-semibold hover:bg-[#f4f2fb]";
      const dot = document.createElement("span");
      let dotColor = "bg-coral shadow-[0_0_0_2px_#fff,0_0_0_3.5px_rgba(232,112,74,0.35)]";
      if (item.kind === "place") dotColor = "bg-blue shadow-[0_0_0_2px_#fff,0_0_0_3.5px_rgba(91,194,240,0.35)]";
      else if (store.isSeen(item.id)) dotColor = "bg-green shadow-[0_0_0_2px_#fff,0_0_0_3.5px_rgba(67,168,96,0.35)]";
      dot.className = `size-2.5 flex-none rounded-full ${dotColor}`;
      const text = document.createElement("span");
      text.textContent = item.label;
      if (item.sub) {
        const sub = document.createElement("span");
        sub.className = "block text-[12px] font-normal text-[#8c8aa8]";
        sub.textContent = item.sub;
        text.appendChild(sub);
      }
      li.append(dot, text);
      li.addEventListener("click", () => {
        close();
        input.blur();
        onPick(item);
      });
      resultsEl.appendChild(li);
    };

    if (items.length) {
      addGroup("Signs");
      items.forEach(addOption);
    }
    if (photonItems.length) {
      addGroup("Places");
      photonItems.forEach(addOption);
    }
    resultsEl.hidden = false;
  }

  function handleInput(): void {
    const q = input.value.trim();
    wrapEl.classList.toggle("has-text", q.length > 0);
    if (!q) {
      close();
      return;
    }
    const locals = q.length >= 2 ? localMatches(q) : [];
    render(locals, [], q);
    if (q.length >= 3) {
      geocoder.query(q, (places) => {
        render(locals, places.map((p): PlaceItem => ({ kind: "place", ...p })), q);
      });
    } else {
      geocoder.cancel();
    }
  }

  function close(): void {
    resultsEl.hidden = true;
    geocoder.cancel();
  }

  input.addEventListener("input", handleInput);
  input.addEventListener("focus", () => { if (input.value.trim()) handleInput(); });
  clearBtn.addEventListener("click", () => {
    input.value = "";
    wrapEl.classList.remove("has-text");
    close();
    input.focus();
  });
  document.addEventListener("click", (e) => {
    if (!wrapEl.parentElement?.contains(e.target as Node)) close();
  });

  return { buildIndex, close };
}
