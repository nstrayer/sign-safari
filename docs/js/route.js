// Route planner tab: network-style view of the street graph with every sign
// as a node, plus greedy + 2-opt routing along real streets.
//
// Data comes from data/network.json (built by scripts/build_network.py):
//   nodes: [lon0, lat0, lon1, lat1, ...]
//   edges: [a, b, meters, ...] as node indices
//   signs: [{ id, addr, n }] where n indexes nodes
//
// All routing runs client-side: Dijkstra over a CSR adjacency, a greedy
// nearest-unvisited walk from the seed until the budget runs out, then
// 2-opt to untangle the visiting order.

const COLORS = {
  street: "#c9cdd4",
  intersection: "#aab0b9",
  unseen: "#e8704a",
  seen: "#43a860",
  route: "#2f3061",
  seed: "#ffb43b",
};

const MIN_PER_KM = 12; // casual walking pace

// ---------- Graph ----------

function buildGraph(raw) {
  const nodeCount = raw.nodes.length / 2;
  const edgeCount = raw.edges.length / 3;

  // World coords: equirectangular, lon squished by cos(mid latitude) so
  // shapes and the pinch-zoom aspect look right.
  let latMin = Infinity, latMax = -Infinity;
  for (let i = 0; i < nodeCount; i++) {
    const lat = raw.nodes[i * 2 + 1];
    if (lat < latMin) latMin = lat;
    if (lat > latMax) latMax = lat;
  }
  const kx = Math.cos(((latMin + latMax) / 2) * Math.PI / 180);
  const xs = new Float64Array(nodeCount);
  const ys = new Float64Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    xs[i] = raw.nodes[i * 2] * kx;
    ys[i] = raw.nodes[i * 2 + 1];
  }

  // CSR adjacency (undirected: each edge appears in both directions).
  const deg = new Int32Array(nodeCount);
  for (let e = 0; e < edgeCount; e++) {
    deg[raw.edges[e * 3]]++;
    deg[raw.edges[e * 3 + 1]]++;
  }
  const off = new Int32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) off[i + 1] = off[i] + deg[i];
  const adj = new Int32Array(edgeCount * 2);
  const wt = new Float32Array(edgeCount * 2);
  const cur = off.slice(0, nodeCount);
  for (let e = 0; e < edgeCount; e++) {
    const a = raw.edges[e * 3], b = raw.edges[e * 3 + 1], w = raw.edges[e * 3 + 2];
    adj[cur[a]] = b; wt[cur[a]++] = w;
    adj[cur[b]] = a; wt[cur[b]++] = w;
  }

  const signNode = new Set(raw.signs.map((s) => s.n));
  return { nodeCount, edgeCount, xs, ys, off, adj, wt, edges: raw.edges, signs: raw.signs, signNode };
}

// ---------- Dijkstra ----------

function makeHeap(cap) {
  let keys = new Float32Array(cap);
  let nodes = new Int32Array(cap);
  let size = 0;
  return {
    get size() { return size; },
    push(key, node) {
      if (size === keys.length) {
        const k2 = new Float32Array(size * 2), n2 = new Int32Array(size * 2);
        k2.set(keys); n2.set(nodes); keys = k2; nodes = n2;
      }
      let i = size++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (keys[p] <= key) break;
        keys[i] = keys[p]; nodes[i] = nodes[p]; i = p;
      }
      keys[i] = key; nodes[i] = node;
    },
    pop() {
      const top = nodes[0];
      const key = keys[--size], node = nodes[size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= size) break;
        const c = l + 1 < size && keys[l + 1] < keys[l] ? l + 1 : l;
        if (keys[c] >= key) break;
        keys[i] = keys[c]; nodes[i] = nodes[c]; i = c;
      }
      keys[i] = key; nodes[i] = node;
      return top;
    },
    peekKey: () => keys[0],
  };
}

function dijkstra(graph, src) {
  const { nodeCount, off, adj, wt } = graph;
  const dist = new Float32Array(nodeCount).fill(Infinity);
  const prev = new Int32Array(nodeCount).fill(-1);
  const heap = makeHeap(1024);
  dist[src] = 0;
  heap.push(0, src);
  while (heap.size) {
    const key = heap.peekKey();
    const u = heap.pop();
    if (key > dist[u]) continue; // stale entry
    for (let i = off[u]; i < off[u + 1]; i++) {
      const v = adj[i];
      const nd = dist[u] + wt[i];
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        heap.push(nd, v);
      }
    }
  }
  return { dist, prev };
}

// LRU cache of full Dijkstra results keyed by source node.
function makeDijkstraCache(graph, cap = 48) {
  const cache = new Map();
  return (src) => {
    if (cache.has(src)) {
      const hit = cache.get(src);
      cache.delete(src);
      cache.set(src, hit);
      return hit;
    }
    const result = dijkstra(graph, src);
    cache.set(src, result);
    if (cache.size > cap) cache.delete(cache.keys().next().value);
    return result;
  };
}

// ---------- Routing ----------

function buildRoute(graph, shortest, seedIdx, { maxMeters, maxCount, excluded }) {
  const { signs } = graph;
  // Distances from one sign to all signs, as a compact per-stop row.
  const rows = new Map();
  const rowFor = (si) => {
    if (!rows.has(si)) {
      const { dist } = shortest(signs[si].n);
      const row = new Float32Array(signs.length);
      for (let j = 0; j < signs.length; j++) row[j] = dist[signs[j].n];
      rows.set(si, row);
    }
    return rows.get(si);
  };

  const stops = [seedIdx];
  const todo = new Set();
  for (let i = 0; i < signs.length; i++) {
    if (i !== seedIdx && !excluded.has(i)) todo.add(i);
  }

  let total = 0;
  while (todo.size && stops.length < maxCount) {
    const row = rowFor(stops[stops.length - 1]);
    let best = -1, bestD = Infinity;
    for (const c of todo) {
      if (row[c] < bestD) { bestD = row[c]; best = c; }
    }
    if (best < 0 || !isFinite(bestD) || total + bestD > maxMeters) break;
    stops.push(best);
    todo.delete(best);
    total += bestD;
  }

  // 2-opt: reverse segments while the open path gets shorter.
  const D = (a, b) => rowFor(a)[b];
  let improved = stops.length > 2;
  while (improved) {
    improved = false;
    for (let i = 1; i < stops.length - 1; i++) {
      for (let j = i + 1; j < stops.length; j++) {
        let delta = D(stops[i - 1], stops[j]) - D(stops[i - 1], stops[i]);
        if (j + 1 < stops.length) delta += D(stops[i], stops[j + 1]) - D(stops[j], stops[j + 1]);
        if (delta < -0.01) {
          let lo = i, hi = j;
          while (lo < hi) { const t = stops[lo]; stops[lo++] = stops[hi]; stops[hi--] = t; }
          improved = true;
        }
      }
    }
  }

  total = 0;
  for (let i = 0; i + 1 < stops.length; i++) total += D(stops[i], stops[i + 1]);

  // Node path for each leg, walking prev[] back from the leg's end.
  const pathNodes = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const { prev } = shortest(signs[stops[i]].n);
    const leg = [];
    for (let v = signs[stops[i + 1]].n; v !== -1; v = prev[v]) leg.push(v);
    leg.reverse();
    pathNodes.push(...(i === 0 ? leg : leg.slice(1)));
  }

  return { stops, totalMeters: total, pathNodes };
}

// ---------- View ----------

export function createRoutePlanner({ store }) {
  const el = (id) => document.getElementById(id);
  const els = {
    view: el("routeView"),
    canvas: el("routeCanvas"),
    hint: el("routeHint"),
    loading: el("routeLoading"),
    modeDistance: el("modeDistance"),
    modeCount: el("modeCount"),
    slider: el("budgetSlider"),
    budgetLabel: el("budgetLabel"),
    skipSeen: el("skipSeen"),
    summary: el("routeSummary"),
    stops: el("routeStops"),
  };
  const ctx = els.canvas.getContext("2d");

  let graph = null;
  let shortest = null;
  let streetsPath = null; // Path2D in world coords
  let loadPromise = null;

  // View state: world center + pixels per world unit.
  const view = { cx: 0, cy: 0, scale: 1, fitScale: 1 };
  let seedIdx = -1;
  let route = null;
  let routePath = null; // Path2D in world coords
  let mode = "distance"; // or "count"
  let needsDraw = false;

  // ---------- Loading ----------

  function load() {
    if (!loadPromise) {
      loadPromise = fetch("./data/network.json")
        .then((res) => {
          if (!res.ok) throw new Error(`network.json: ${res.status}`);
          return res.json();
        })
        .then((raw) => {
          graph = buildGraph(raw);
          shortest = makeDijkstraCache(graph);
          streetsPath = new Path2D();
          for (let e = 0; e < graph.edgeCount; e++) {
            const a = graph.edges[e * 3], b = graph.edges[e * 3 + 1];
            streetsPath.moveTo(graph.xs[a], graph.ys[a]);
            streetsPath.lineTo(graph.xs[b], graph.ys[b]);
          }
          els.loading.hidden = true;
          fitToSigns();
          scheduleDraw();
        })
        .catch((err) => {
          console.error(err);
          els.loading.textContent = "Couldn't load the street network. Check your connection and refresh.";
        });
    }
    return loadPromise;
  }

  function fitToSigns() {
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const s of graph.signs) {
      const x = graph.xs[s.n], y = graph.ys[s.n];
      if (x < xMin) xMin = x; if (x > xMax) xMax = x;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    }
    const w = els.canvas.clientWidth || innerWidth;
    const h = els.canvas.clientHeight || innerHeight;
    view.cx = (xMin + xMax) / 2;
    view.cy = (yMin + yMax) / 2;
    view.fitScale = 0.92 * Math.min(w / (xMax - xMin), h / (yMax - yMin));
    view.scale = view.fitScale;
  }

  // Zoom to the built route, framed in the canvas area above the card.
  function fitToRoute() {
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const n of route.pathNodes) {
      const x = graph.xs[n], y = graph.ys[n];
      if (x < xMin) xMin = x; if (x > xMax) xMax = x;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    }
    const w = els.canvas.clientWidth, h = els.canvas.clientHeight;
    // On phones the card overlays the bottom; on wide screens it sits on
    // the right. Frame the route in the space that's left.
    const wide = matchMedia("(min-width: 720px)").matches;
    const headerPx = 100;
    const availW = wide ? w - 420 : w;
    const availH = wide ? h - headerPx - 24 : Math.max(h * 0.42 - headerPx, 120);
    const spanX = Math.max(xMax - xMin, 1e-5), spanY = Math.max(yMax - yMin, 1e-5);
    view.scale = Math.min(0.85 * Math.min(availW / spanX, availH / spanY), view.fitScale * 200);
    view.cx = (xMin + xMax) / 2 + (w / 2 - availW / 2) / view.scale;
    view.cy = (yMin + yMax) / 2 + (headerPx + availH / 2 - h / 2) / view.scale;
  }

  // ---------- Rendering ----------

  function resize() {
    const dpr = devicePixelRatio || 1;
    const w = els.canvas.clientWidth, h = els.canvas.clientHeight;
    if (els.canvas.width !== w * dpr || els.canvas.height !== h * dpr) {
      els.canvas.width = w * dpr;
      els.canvas.height = h * dpr;
    }
    scheduleDraw();
  }

  function toScreen(x, y) {
    const w = els.canvas.clientWidth, h = els.canvas.clientHeight;
    return [(x - view.cx) * view.scale + w / 2, (view.cy - y) * view.scale + h / 2];
  }

  function scheduleDraw() {
    if (needsDraw) return;
    needsDraw = true;
    requestAnimationFrame(() => {
      needsDraw = false;
      draw();
    });
  }

  function draw() {
    if (!graph || els.view.hidden) return;
    const dpr = devicePixelRatio || 1;
    const w = els.canvas.clientWidth, h = els.canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Streets (and the route) stroke in world coordinates.
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(view.scale, -view.scale);
    ctx.translate(-view.cx, -view.cy);
    ctx.lineWidth = 1.1 / view.scale;
    ctx.strokeStyle = COLORS.street;
    ctx.stroke(streetsPath);
    if (routePath) {
      ctx.lineWidth = 4 / view.scale;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = COLORS.route;
      ctx.stroke(routePath);
    }
    ctx.restore();

    // Signs in screen space so dot sizes stay honest across zooms.
    const r = Math.max(2.5, Math.min(9, view.scale / 1400));
    const unseenDots = new Path2D();
    const seenDots = new Path2D();
    for (const s of graph.signs) {
      const [sx, sy] = toScreen(graph.xs[s.n], graph.ys[s.n]);
      if (sx < -20 || sy < -20 || sx > w + 20 || sy > h + 20) continue;
      const path = store.isSeen(s.id) ? seenDots : unseenDots;
      path.moveTo(sx + r, sy);
      path.arc(sx, sy, r, 0, Math.PI * 2);
    }
    ctx.fillStyle = COLORS.seen;
    ctx.fill(seenDots);
    ctx.fillStyle = COLORS.unseen;
    ctx.fill(unseenDots);

    // Route stops: numbered, in visit order. Seed gets a gold halo.
    if (route) {
      for (let i = 0; i < route.stops.length; i++) {
        const s = graph.signs[route.stops[i]];
        const [sx, sy] = toScreen(graph.xs[s.n], graph.ys[s.n]);
        ctx.beginPath();
        ctx.arc(sx, sy, 10, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? COLORS.seed : COLORS.route;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = i === 0 ? COLORS.route : "#fff";
        ctx.font = "700 11px 'Nunito Sans', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(i + 1), sx, sy + 0.5);
      }
    } else if (seedIdx >= 0) {
      const s = graph.signs[seedIdx];
      const [sx, sy] = toScreen(graph.xs[s.n], graph.ys[s.n]);
      ctx.beginPath();
      ctx.arc(sx, sy, 12, 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.seed;
      ctx.lineWidth = 4;
      ctx.stroke();
    }
  }

  // ---------- Interaction: pan / zoom / tap ----------

  const pointers = new Map();
  let moved = false;

  function zoomAt(px, py, factor) {
    const w = els.canvas.clientWidth, h = els.canvas.clientHeight;
    const next = Math.min(view.fitScale * 200, Math.max(view.fitScale * 0.7, view.scale * factor));
    factor = next / view.scale;
    // Keep the world point under (px, py) fixed.
    view.cx += (px - w / 2) * (1 - 1 / factor) / view.scale;
    view.cy -= (py - h / 2) * (1 - 1 / factor) / view.scale;
    view.scale = next;
    scheduleDraw();
  }

  els.canvas.addEventListener("pointerdown", (e) => {
    els.canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
  });

  els.canvas.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    if (pointers.size === 1) {
      view.cx -= dx / view.scale;
      view.cy += dy / view.scale;
      scheduleDraw();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const before = Math.hypot(a.x - b.x, a.y - b.y);
      p.x = e.clientX; p.y = e.clientY;
      const [a2, b2] = [...pointers.values()];
      const after = Math.hypot(a2.x - b2.x, a2.y - b2.y);
      const rect = els.canvas.getBoundingClientRect();
      zoomAt((a2.x + b2.x) / 2 - rect.left, (a2.y + b2.y) / 2 - rect.top, after / before);
      return;
    }
    p.x = e.clientX; p.y = e.clientY;
  });

  function pointerEnd(e) {
    pointers.delete(e.pointerId);
    if (!moved && graph) {
      const rect = els.canvas.getBoundingClientRect();
      tap(e.clientX - rect.left, e.clientY - rect.top);
    }
  }
  els.canvas.addEventListener("pointerup", pointerEnd);
  els.canvas.addEventListener("pointercancel", (e) => pointers.delete(e.pointerId));

  els.canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = els.canvas.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.pow(1.0015, -e.deltaY));
  }, { passive: false });

  function tap(px, py) {
    let best = -1, bestD = 22 * 22;
    for (let i = 0; i < graph.signs.length; i++) {
      const [sx, sy] = toScreen(graph.xs[graph.signs[i].n], graph.ys[graph.signs[i].n]);
      const d = (sx - px) ** 2 + (sy - py) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) {
      seedIdx = best;
      els.hint.textContent = `Starting at ${graph.signs[best].addr}`;
      rebuild();
    }
  }

  // ---------- Controls ----------

  function sliderConfig() {
    if (mode === "distance") {
      Object.assign(els.slider, { min: 0.5, max: 15, step: 0.5 });
      if (+els.slider.value > 15) els.slider.value = 3;
    } else {
      Object.assign(els.slider, { min: 5, max: 100, step: 5 });
      if (+els.slider.value < 5) els.slider.value = 20;
    }
  }

  function budgetText() {
    return mode === "distance" ? `${(+els.slider.value).toFixed(1)} km` : `${els.slider.value} signs`;
  }

  function setMode(next) {
    mode = next;
    els.modeDistance.classList.toggle("is-active", mode === "distance");
    els.modeCount.classList.toggle("is-active", mode === "count");
    const keep = els.slider.value;
    sliderConfig();
    if (mode === "distance" && !(+keep >= 0.5 && +keep <= 15)) els.slider.value = 3;
    if (mode === "count" && !(+keep >= 5 && +keep <= 100)) els.slider.value = 20;
    els.budgetLabel.textContent = budgetText();
    rebuild();
  }

  els.modeDistance.addEventListener("click", () => setMode("distance"));
  els.modeCount.addEventListener("click", () => setMode("count"));
  els.slider.addEventListener("input", () => { els.budgetLabel.textContent = budgetText(); });
  els.slider.addEventListener("change", rebuild);
  els.skipSeen.addEventListener("change", rebuild);
  store.onSeenChange(() => scheduleDraw());

  function rebuild() {
    if (seedIdx < 0 || !graph) return;
    els.summary.hidden = false;
    els.summary.textContent = "Building route...";
    els.stops.hidden = true;
    // Let the status paint before the synchronous Dijkstra work starts.
    setTimeout(() => {
      const excluded = new Set();
      if (els.skipSeen.checked) {
        for (let i = 0; i < graph.signs.length; i++) {
          if (i !== seedIdx && store.isSeen(graph.signs[i].id)) excluded.add(i);
        }
      }
      route = buildRoute(graph, shortest, seedIdx, {
        maxMeters: mode === "distance" ? +els.slider.value * 1000 : Infinity,
        maxCount: mode === "count" ? +els.slider.value : Infinity,
        excluded,
      });
      routePath = new Path2D();
      route.pathNodes.forEach((n, i) => {
        if (i === 0) routePath.moveTo(graph.xs[n], graph.ys[n]);
        else routePath.lineTo(graph.xs[n], graph.ys[n]);
      });
      renderResult();
      if (route) fitToRoute();
      scheduleDraw();
    }, 30);
  }

  function renderResult() {
    const km = route.totalMeters / 1000;
    if (route.stops.length < 2) {
      els.summary.textContent = "No reachable signs fit that budget - loosen it or pick another start.";
      els.stops.hidden = true;
      route = null;
      routePath = null;
      return;
    }
    els.summary.textContent =
      `${route.stops.length} signs · ${km.toFixed(1)} km · ~${Math.round(km * MIN_PER_KM)} min`;
    els.stops.innerHTML = "";
    for (const si of route.stops) {
      const s = graph.signs[si];
      const li = document.createElement("li");
      li.textContent = s.addr;
      if (store.isSeen(s.id)) li.classList.add("stop-seen");
      li.addEventListener("click", () => {
        view.cx = graph.xs[s.n];
        view.cy = graph.ys[s.n];
        view.scale = Math.max(view.scale, view.fitScale * 12);
        scheduleDraw();
      });
      els.stops.appendChild(li);
    }
    els.stops.hidden = false;
  }

  // ---------- Lifecycle ----------

  new ResizeObserver(resize).observe(els.canvas);
  sliderConfig();
  els.budgetLabel.textContent = budgetText();

  return {
    load,
    show() {
      els.view.hidden = false;
      load().then(() => {
        resize();
        scheduleDraw();
      });
    },
    hide() {
      els.view.hidden = true;
    },
  };
}
