// Local-first search: instant substring match over sign addresses, with
// Photon (komoot.io) place results appended for anything beyond the dataset.

const PHOTON_URL = "https://photon.komoot.io/api/";
const AREA = { lat: 42.2808, lon: -83.743, bbox: "-84.25,42.0,-83.35,42.55" };

function norm(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function createSearch({ input, clearBtn, resultsEl, wrapEl, store, onPick }) {
  let index = [];
  let photonAbort = null;
  let debounceTimer = null;

  function buildIndex(collections) {
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

  function localMatches(q) {
    const nq = norm(q);
    const starts = [];
    const contains = [];
    for (const item of index) {
      if (item.key.startsWith(nq)) starts.push(item);
      else if (item.key.includes(nq)) contains.push(item);
      if (starts.length >= 6) break;
    }
    return [...starts, ...contains].slice(0, 6);
  }

  function render(items, photonItems, q) {
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

    const addGroup = (label) => {
      const li = document.createElement("li");
      li.className = "group-label";
      li.textContent = label;
      resultsEl.appendChild(li);
    };

    const addOption = (item) => {
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

  async function queryPhoton(q, localItems) {
    photonAbort?.abort();
    photonAbort = new AbortController();
    const url = `${PHOTON_URL}?q=${encodeURIComponent(q)}&lat=${AREA.lat}&lon=${AREA.lon}&bbox=${AREA.bbox}&limit=5`;
    try {
      const res = await fetch(url, { signal: photonAbort.signal });
      if (!res.ok) return;
      const data = await res.json();
      if (norm(input.value.trim()) !== norm(q)) return; // stale
      const places = (data.features ?? []).map((f) => {
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
      if (e.name !== "AbortError") console.warn("Photon search failed", e);
    }
  }

  function handleInput() {
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

  function close() {
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
    if (!wrapEl.parentElement.contains(e.target)) close();
  });

  return { buildIndex, close };
}
