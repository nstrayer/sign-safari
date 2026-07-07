// Local-first search: instant substring match over sign addresses, with
// Photon (komoot.io) place results appended for anything beyond the dataset.

import type { Store } from "./store";
import type { Kind, LonLat, PhotonResponse, SignCollection, SignProps } from "./types";

const PHOTON_URL = "https://photon.komoot.io/api/";
const AREA = { lat: 42.2808, lon: -83.743, bbox: "-84.25,42.0,-83.35,42.55" };

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
interface PlaceItem {
  kind: "place";
  label: string;
  sub: string;
  coords: LonLat;
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
  let photonAbort: AbortController | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

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
        li.className = "no-results";
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
      li.className = "group-label";
      li.textContent = label;
      resultsEl.appendChild(li);
    };

    const addOption = (item: SearchItem) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      const dot = document.createElement("span");
      dot.className = "result-dot";
      if (item.kind === "place") dot.classList.add("place");
      else if (store.isSeen(item.id)) dot.classList.add("seen");
      const text = document.createElement("span");
      text.textContent = item.label;
      if (item.sub) {
        const sub = document.createElement("span");
        sub.className = "result-sub";
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

  async function queryPhoton(q: string, localItems: LocalItem[]): Promise<void> {
    photonAbort?.abort();
    photonAbort = new AbortController();
    const url = `${PHOTON_URL}?q=${encodeURIComponent(q)}&lat=${AREA.lat}&lon=${AREA.lon}&bbox=${AREA.bbox}&limit=5`;
    try {
      const res = await fetch(url, { signal: photonAbort.signal });
      if (!res.ok) return;
      const data = (await res.json()) as PhotonResponse;
      if (norm(input.value.trim()) !== norm(q)) return; // stale
      const places: PlaceItem[] = (data.features ?? []).map((f) => {
        const p = f.properties;
        const parts = [p.street && p.housenumber ? `${p.housenumber} ${p.street}` : p.street, p.city ?? p.district];
        return {
          kind: "place",
          label: p.name ?? parts[0] ?? "Unknown place",
          sub: parts.filter(Boolean).join(", ") || p.state || "",
          coords: f.geometry.coordinates,
        };
      });
      render(localItems, places, q);
    } catch (e) {
      if (!(e instanceof Error) || e.name !== "AbortError") console.warn("Photon search failed", e);
    }
  }

  function handleInput(): void {
    const q = input.value.trim();
    wrapEl.classList.toggle("has-text", q.length > 0);
    clearTimeout(debounceTimer);
    if (!q) {
      close();
      return;
    }
    const locals = q.length >= 2 ? localMatches(q) : [];
    render(locals, [], q);
    if (q.length >= 3) {
      debounceTimer = setTimeout(() => queryPhoton(q, locals), 300);
    }
  }

  function close(): void {
    resultsEl.hidden = true;
    photonAbort?.abort();
    clearTimeout(debounceTimer);
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
