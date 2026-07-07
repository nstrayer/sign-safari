// Route planner tab: network-style view of the street graph with every sign
// as a node, plus greedy + 2-opt routing along real streets.
//
// Data comes from data/network.json (built by scripts/build_network.py):
//   nodes: [lon0, lat0, lon1, lat1, ...]
//   edges: [a, b, meters, ...] as node indices
//   signs: [{ id, addr, n }] where n indexes nodes
//
// The tab walks through a tiny wizard: pick a start (geolocation, address
// search, or tapping a sign), pick a distance or sign-count budget, get an
// optimized route drawn on the network plus a GPX export for watches.
//
// All routing runs client-side: Dijkstra over a CSR adjacency, a greedy
// nearest-unvisited walk from the seed until the budget runs out, then
// 2-opt to untangle the visiting order.

const COLORS = {
  street: "#c9cdd4",
  unseen: "#e8704a",
  seen: "#43a860",
  route: "#2f3061",
  seed: "#ffb43b",
};

const MIN_PER_KM = 12; // casual walking pace
const DEG_M = 111320; // meters per degree of latitude (and cos-corrected lon)
const INTRO_KEY = "sg2026.routeIntro";
const PHOTON_URL = "https://photon.komoot.io/api/";
const AREA = { lat: 42.2808, lon: -83.743, bbox: "-84.25,42.0,-83.35,42.55" };

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

  return { nodeCount, edgeCount, kx, xs, ys, off, adj, wt, edges: raw.edges, signs: raw.signs };
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

// LRU cache of full Dijkstra results keyed by source node. The cap needs
// headroom for the largest routes: an 80-stop build touches ~80 sources
// during 2-opt and leg assembly, and thrashing means recomputing them.
function makeDijkstraCache(graph, cap = 128) {
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

// The seed is any node on the network (a sign's node, or the node nearest a
// geolocation/address). A sign sitting exactly at the seed is simply the
// first greedy pick at 0 m. With `loop`, the route returns to the seed and
// the budget covers the leg home.
//
// The build is split into pieces so the UI can narrate and animate it:
// greedy draft first, then a 2-opt generator that yields after every
// accepted improvement.

// Per-build cache of "distance from node X to every sign" rows.
function makeRows(graph, shortest) {
  const rows = new Map();
  return (node) => {
    if (!rows.has(node)) {
      const { dist } = shortest(node);
      const row = new Float32Array(graph.signs.length);
      for (let j = 0; j < graph.signs.length; j++) row[j] = dist[graph.signs[j].n];
      rows.set(node, row);
    }
    return rows.get(node);
  };
}

// Greedy: extend an existing stop order (possibly empty) by repeatedly
// walking to the nearest sign that still fits the budget (including, for
// loops, the return leg home; the undirected graph makes the seed's own
// row double as "distance home"). Mutates stopSigns; also used to refill
// budget freed up by 2-opt.
function greedyExtend(graph, rowFor, seedNode, stopSigns, spentMeters, { maxMeters, maxCount, excluded, loop }) {
  const { signs } = graph;
  const homeRow = rowFor(seedNode);
  const used = new Set(stopSigns);
  const todo = new Set();
  for (let i = 0; i < signs.length; i++) {
    if (!excluded.has(i) && !used.has(i)) todo.add(i);
  }

  let total = spentMeters;
  let cursor = stopSigns.length ? signs[stopSigns[stopSigns.length - 1]].n : seedNode;
  let added = 0;
  while (todo.size && stopSigns.length < maxCount) {
    const row = rowFor(cursor);
    let best = -1, bestD = Infinity;
    for (const c of todo) {
      if (row[c] >= bestD) continue;
      if (total + row[c] + (loop ? homeRow[c] : 0) > maxMeters) continue;
      bestD = row[c];
      best = c;
    }
    if (best < 0 || !isFinite(bestD)) break;
    stopSigns.push(best);
    todo.delete(best);
    total += bestD;
    added++;
    cursor = signs[best].n;
  }
  return added;
}

// Path length of a stop order, with and without the loop leg home.
function routeTotals(graph, rowFor, seedNode, stopSigns, loop) {
  const homeRow = rowFor(seedNode);
  let pathMeters = 0;
  let prevNode = seedNode;
  for (const si of stopSigns) {
    pathMeters += rowFor(prevNode)[si];
    prevNode = graph.signs[si].n;
  }
  const home = loop && stopSigns.length ? homeRow[stopSigns[stopSigns.length - 1]] : 0;
  return { pathMeters, totalMeters: pathMeters + home };
}

// Multi-start: greedy is myopic about its opening move, so run it once for
// each of the k nearest viable first signs and let the results race.
// Duplicates (openers that converge to the same route) are dropped.
function buildCandidates(graph, rowFor, seedNode, opts, k = 4) {
  const homeRow = rowFor(seedNode);
  const openers = [];
  for (let i = 0; i < graph.signs.length; i++) {
    if (opts.excluded.has(i)) continue;
    const d = homeRow[i];
    if (!isFinite(d) || d + (opts.loop ? homeRow[i] : 0) > opts.maxMeters) continue;
    openers.push([d, i]);
  }
  openers.sort((a, b) => a[0] - b[0]);

  const dedupe = new Set();
  const candidates = [];
  for (const [d, first] of openers.slice(0, k)) {
    const stopSigns = [first];
    greedyExtend(graph, rowFor, seedNode, stopSigns, d, opts);
    const key = stopSigns.join(",");
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    candidates.push({ stopSigns, ...routeTotals(graph, rowFor, seedNode, stopSigns, opts.loop) });
  }
  return candidates;
}

// 2-opt with the seed as a fixed anchor: reverse segments while the path
// (plus the leg home, when looping) gets shorter. Mutates stopSigns and
// yields after each accepted reversal so the caller can animate it.
function* twoOptSteps(graph, rowFor, seedNode, stopSigns, loop) {
  const { signs } = graph;
  const homeRow = rowFor(seedNode);
  const nodeOf = (p) => (p < 0 ? seedNode : signs[stopSigns[p]].n);
  const D = (p, signPos) => rowFor(nodeOf(p))[stopSigns[signPos]];
  let saved = 0;
  for (let pass = 1; pass <= 10; pass++) {
    let improved = false;
    for (let i = 0; i < stopSigns.length - 1; i++) {
      for (let j = i + 1; j < stopSigns.length; j++) {
        let delta = D(i - 1, j) - D(i - 1, i);
        if (j + 1 < stopSigns.length) delta += D(i, j + 1) - D(j, j + 1);
        else if (loop) delta += homeRow[stopSigns[i]] - homeRow[stopSigns[j]];
        if (delta < -0.01) {
          let lo = i, hi = j;
          while (lo < hi) { const t = stopSigns[lo]; stopSigns[lo++] = stopSigns[hi]; stopSigns[hi--] = t; }
          saved -= delta;
          improved = true;
          yield { pass, saved };
        }
      }
    }
    if (!improved) break;
  }
}

// Street-node path for the current stop order: one leg per stop, walking
// prev[] back from each leg's end, plus the leg home when looping.
function legsForOrder(graph, shortest, seedNode, stopSigns, loop) {
  const targets = stopSigns.map((si) => graph.signs[si].n);
  if (loop && stopSigns.length) targets.push(seedNode);
  const legs = [];
  let from = seedNode;
  for (const to of targets) {
    const { prev } = shortest(from);
    const leg = [];
    for (let v = to; v !== -1; v = prev[v]) leg.push(v);
    leg.reverse();
    legs.push(leg);
    from = to;
  }
  return legs;
}

// ---------- View ----------

export function createRoutePlanner({ store, showToast }) {
  const el = (id) => document.getElementById(id);
  const els = {
    view: el("routeView"),
    canvas: el("routeCanvas"),
    hint: el("routeHint"),
    loading: el("routeLoading"),
    stepIntro: el("stepIntro"),
    stepStart: el("stepStart"),
    stepPlan: el("stepPlan"),
    introGo: el("introGo"),
    useLocation: el("useLocation"),
    addrInput: el("addrInput"),
    addrResults: el("addrResults"),
    seedLabel: el("seedLabel"),
    changeStart: el("changeStart"),
    modeDistance: el("modeDistance"),
    modeCount: el("modeCount"),
    slider: el("budgetSlider"),
    budgetLabel: el("budgetLabel"),
    skipSeen: el("skipSeen"),
    loopBack: el("loopBack"),
    summary: el("routeSummary"),
    actions: el("routeActions"),
    exportGpx: el("exportGpx"),
    stops: el("routeStops"),
  };
  const ctx = els.canvas.getContext("2d");

  let graph = null;
  let shortest = null;
  let streetsPath = null; // Path2D in world coords
  let loadPromise = null;

  // View state: world center + pixels per world unit.
  const view = { cx: 0, cy: 0, scale: 1, fitScale: 1 };
  let seed = null; // { node, label, isSign }
  let route = null;
  let routePath = null; // Path2D in world coords
  let race = null; // [{ path, color, alpha }] while candidate routes race
  let mode = "distance"; // or "count"
  let needsDraw = false;

  // ---------- Wizard steps ----------

  function setStep(step) {
    els.stepIntro.hidden = step !== "intro";
    els.stepStart.hidden = step !== "start";
    els.stepPlan.hidden = step !== "plan";
    els.hint.hidden = step === "intro";
    if (step === "start") els.hint.textContent = "You can also just tap a sign dot";
    if (step === "plan") els.hint.textContent = `Starting at ${seed.label}`;
  }

  function currentStep() {
    if (!els.stepIntro.hidden) return "intro";
    if (!els.stepStart.hidden) return "start";
    return "plan";
  }

  function setSeed(next) {
    seed = next;
    els.seedLabel.textContent = seed.label;
    try { localStorage.setItem(INTRO_KEY, "1"); } catch {}
    setStep("plan");
    rebuild();
  }

  els.introGo.addEventListener("click", () => {
    try { localStorage.setItem(INTRO_KEY, "1"); } catch {}
    setStep("start");
  });

  els.changeStart.addEventListener("click", () => {
    seed = null;
    route = null;
    routePath = null;
    race = null;
    setStep("start");
    scheduleDraw();
  });

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

  // Zoom to a set of path nodes, framed in the canvas area the card leaves free.
  function fitToNodes(nodes) {
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const n of nodes) {
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

  function drawBadge(sx, sy, text, fill, textFill) {
    ctx.beginPath();
    ctx.arc(sx, sy, 10, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = textFill;
    ctx.font = "700 11px 'Nunito Sans', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, sx, sy + 0.5);
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

    // Racing candidate routes go above the dots, dashed differently per
    // candidate so overlapping stretches stay tellable-apart.
    if (race) {
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(view.scale, -view.scale);
      ctx.translate(-view.cx, -view.cy);
      const dashes = [[], [10, 7], [5, 5], [2.5, 6]];
      race.forEach((c, i) => {
        if (c.alpha < 0.02) return;
        ctx.globalAlpha = c.alpha;
        ctx.lineWidth = (3.4 - i * 0.4) / view.scale;
        ctx.setLineDash(dashes[i % 4].map((d) => d / view.scale));
        ctx.lineJoin = "round";
        ctx.strokeStyle = c.color;
        ctx.stroke(c.path);
      });
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // Start anchor, unless the first stop sits exactly on it.
    if (seed) {
      const firstStopNode = route?.stopSigns.length ? graph.signs[route.stopSigns[0]].n : -1;
      if (firstStopNode !== seed.node) {
        const [sx, sy] = toScreen(graph.xs[seed.node], graph.ys[seed.node]);
        drawBadge(sx, sy, "S", COLORS.seed, COLORS.route);
      }
    }

    // Route stops: numbered, in visit order. During the build animation
    // `shown` limits badges to the stops collected so far.
    if (route) {
      const count = route.shown ?? route.stopSigns.length;
      for (let i = 0; i < count; i++) {
        const s = graph.signs[route.stopSigns[i]];
        const [sx, sy] = toScreen(graph.xs[s.n], graph.ys[s.n]);
        const isStart = i === 0 && s.n === seed.node;
        drawBadge(sx, sy, String(i + 1), isStart ? COLORS.seed : COLORS.route, isStart ? COLORS.route : "#fff");
      }
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
      const s = graph.signs[best];
      setSeed({ node: s.n, label: s.addr, isSign: true });
    }
  }

  // ---------- Start step: geolocation + address search ----------

  // Nearest network node to a lon/lat, and roughly how far away it is.
  function nearestNode(lon, lat) {
    const x = lon * graph.kx, y = lat;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < graph.nodeCount; i++) {
      const d = (graph.xs[i] - x) ** 2 + (graph.ys[i] - y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return { node: best, meters: Math.sqrt(bestD) * DEG_M };
  }

  function seedFromCoords(lon, lat, label) {
    const { node, meters } = nearestNode(lon, lat);
    if (meters > 2000) {
      showToast("That spot is outside the mapped street network.");
      return;
    }
    setSeed({ node, label, isSign: false });
  }

  els.useLocation.addEventListener("click", () => {
    if (!navigator.geolocation) {
      showToast("This browser can't share your location.");
      return;
    }
    els.useLocation.disabled = true;
    els.useLocation.textContent = "Locating...";
    const done = () => {
      els.useLocation.disabled = false;
      els.useLocation.textContent = "Use my location";
    };
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        done();
        seedFromCoords(pos.coords.longitude, pos.coords.latitude, "your location");
      },
      () => {
        done();
        showToast("Couldn't get your location - try the address box.");
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // Address search: instant matches over sign addresses, Photon places after
  // a pause (same service and area bias as the map tab's search).
  let addrDebounce = null;
  let photonAbort = null;

  function renderAddrResults(items) {
    els.addrResults.innerHTML = "";
    for (const item of items) {
      const li = document.createElement("li");
      li.textContent = item.label;
      if (item.sub) {
        const sub = document.createElement("span");
        sub.className = "result-sub";
        sub.textContent = item.sub;
        li.appendChild(sub);
      }
      li.addEventListener("click", () => {
        els.addrResults.hidden = true;
        els.addrInput.value = "";
        if (item.sign) setSeed({ node: item.sign.n, label: item.sign.addr, isSign: true });
        else seedFromCoords(item.coords[0], item.coords[1], item.label);
      });
      els.addrResults.appendChild(li);
    }
    els.addrResults.hidden = items.length === 0;
  }

  function localAddrMatches(q) {
    const nq = q.toLowerCase();
    const out = [];
    for (const s of graph.signs) {
      if (s.addr.toLowerCase().includes(nq)) {
        out.push({ label: s.addr, sub: "sign", sign: s });
        if (out.length >= 4) break;
      }
    }
    return out;
  }

  els.addrInput.addEventListener("input", () => {
    const q = els.addrInput.value.trim();
    clearTimeout(addrDebounce);
    photonAbort?.abort();
    if (q.length < 2 || !graph) {
      els.addrResults.hidden = true;
      return;
    }
    const locals = localAddrMatches(q);
    renderAddrResults(locals);
    if (q.length < 3) return;
    addrDebounce = setTimeout(async () => {
      photonAbort = new AbortController();
      const url = `${PHOTON_URL}?q=${encodeURIComponent(q)}&lat=${AREA.lat}&lon=${AREA.lon}&bbox=${AREA.bbox}&limit=4`;
      try {
        const res = await fetch(url, { signal: photonAbort.signal });
        if (!res.ok) return;
        const data = await res.json();
        if (els.addrInput.value.trim() !== q) return; // stale
        const places = (data.features ?? []).map((f) => {
          const p = f.properties;
          const street = p.street && p.housenumber ? `${p.housenumber} ${p.street}` : p.street;
          return {
            label: p.name ?? street ?? "Unknown place",
            sub: [street !== p.name ? street : null, p.city ?? p.district].filter(Boolean).join(", "),
            coords: f.geometry.coordinates,
          };
        });
        renderAddrResults([...locals, ...places]);
      } catch (e) {
        if (e.name !== "AbortError") console.warn("Photon search failed", e);
      }
    }, 300);
  });

  // ---------- Budget controls ----------

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
  els.loopBack.addEventListener("change", rebuild);
  store.onSeenChange(() => scheduleDraw());

  // ---------- Build + result ----------

  let buildGen = 0;

  function pathFromNodes(nodes) {
    const p = new Path2D();
    nodes.forEach((n, i) => {
      if (i === 0) p.moveTo(graph.xs[n], graph.ys[n]);
      else p.lineTo(graph.xs[n], graph.ys[n]);
    });
    return p;
  }

  function setStatus(text) {
    els.summary.hidden = false;
    els.summary.textContent = text;
  }

  function appendLeg(path, leg, isFirst) {
    for (let k = 0; k < leg.length; k++) {
      const n = leg[k];
      if (isFirst && k === 0) path.moveTo(graph.xs[n], graph.ys[n]);
      else path.lineTo(graph.xs[n], graph.ys[n]);
    }
  }

  function rebuild() {
    if (!seed || !graph) return;
    const gen = ++buildGen;
    race = null;
    els.summary.classList.add("building");
    setStatus("Measuring the streets nearby...");
    els.stops.hidden = true;
    els.actions.hidden = true;
    // Let the status paint before the synchronous Dijkstra work starts.
    setTimeout(() => runBuild(gen).catch(console.error), 30);
  }

  // The narrated build: race a few greedy starts against each other, keep
  // the winner, watch 2-opt untangle it, then spend any budget the
  // optimizer freed up on extra signs.
  async function runBuild(gen) {
    const alive = () => gen === buildGen && !!seed && !!graph;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (!alive()) return;

    const excluded = new Set();
    if (els.skipSeen.checked) {
      for (let i = 0; i < graph.signs.length; i++) {
        if (store.isSeen(graph.signs[i].id)) excluded.add(i);
      }
    }
    const loop = els.loopBack.checked;
    const opts = {
      maxMeters: mode === "distance" ? +els.slider.value * 1000 : Infinity,
      maxCount: mode === "count" ? +els.slider.value : Infinity,
      excluded,
      loop,
    };
    const rowFor = makeRows(graph, shortest);
    const candidates = buildCandidates(graph, rowFor, seed.node, opts);
    if (!alive()) return;
    if (!candidates.length) {
      els.summary.classList.remove("building");
      setStatus("No reachable signs fit that budget - loosen it or pick another start.");
      route = null;
      routePath = null;
      scheduleDraw();
      return;
    }

    // More signs wins; fewer meters breaks ties.
    let winnerIdx = 0;
    for (let i = 1; i < candidates.length; i++) {
      const c = candidates[i], w = candidates[winnerIdx];
      if (c.stopSigns.length > w.stopSigns.length ||
          (c.stopSigns.length === w.stopSigns.length && c.totalMeters < w.totalMeters)) {
        winnerIdx = i;
      }
    }
    const candLegs = candidates.map((c) => legsForOrder(graph, shortest, seed.node, c.stopSigns, loop));

    route = null;
    routePath = null;
    fitToNodes(candLegs.flat(2));
    scheduleDraw();

    if (candidates.length > 1) {
      // Phase 1: the race. All candidates snake outward together.
      const colors = ["#d62246", "#5bc2f0", "#ffb43b", "#8b8fe0"];
      race = candidates.map((c, i) => ({ path: new Path2D(), color: colors[i % colors.length], alpha: 0.85 }));
      const maxLegs = Math.max(...candLegs.map((l) => l.length));
      const delay = Math.min(150, Math.max(40, 1800 / maxLegs));
      for (let i = 0; i < maxLegs; i++) {
        candLegs.forEach((legs, ci) => {
          if (i < legs.length) appendLeg(race[ci].path, legs[i], i === 0);
        });
        setStatus(`Trying ${candidates.length} different starts...`);
        scheduleDraw();
        await sleep(delay);
        if (!alive()) return;
      }

      // Phase 2: declare the winner, fade the rest.
      const w = candidates[winnerIdx];
      setStatus(`Route ${String.fromCharCode(65 + winnerIdx)} wins - ${w.stopSigns.length} signs, ${(w.totalMeters / 1000).toFixed(1)} km`);
      await sleep(500);
      if (!alive()) return;
      for (let step = 0; step < 8; step++) {
        race.forEach((c, i) => { if (i !== winnerIdx) c.alpha *= 0.62; });
        scheduleDraw();
        await sleep(55);
        if (!alive()) return;
      }
      race = null;
      route = {
        stopSigns: candidates[winnerIdx].stopSigns,
        totalMeters: candidates[winnerIdx].totalMeters,
        pathNodes: candLegs[winnerIdx].flat(),
      };
      routePath = pathFromNodes(route.pathNodes);
      scheduleDraw();
      await sleep(400);
      if (!alive()) return;
    } else {
      // Single viable start: reveal it leg by leg instead.
      const stopSigns = candidates[0].stopSigns;
      const legs = candLegs[0];
      route = { stopSigns, totalMeters: candidates[0].totalMeters, pathNodes: legs.flat(), shown: 0 };
      routePath = new Path2D();
      const revealDelay = Math.min(120, Math.max(30, 1500 / legs.length));
      for (let i = 0; i < legs.length; i++) {
        appendLeg(routePath, legs[i], i === 0);
        route.shown = Math.min(i + 1, stopSigns.length);
        setStatus(
          loop && i === legs.length - 1
            ? "...and back to the start"
            : `Collecting signs... ${i + 1} of ${stopSigns.length}`
        );
        scheduleDraw();
        await sleep(revealDelay);
        if (!alive()) return;
      }
      route.shown = undefined;
    }

    // Phase 3+4, repeated: untangle with 2-opt, then spend whatever budget
    // the optimizer freed up on more signs, until neither helps.
    const stopSigns = route.stopSigns;
    const refreshRoute = () => {
      const totals = routeTotals(graph, rowFor, seed.node, stopSigns, loop);
      route.totalMeters = totals.totalMeters;
      route.pathNodes = legsForOrder(graph, shortest, seed.node, stopSigns, loop).flat();
      routePath = pathFromNodes(route.pathNodes);
      return totals;
    };

    setStatus("Checking for crossings...");
    await sleep(450);
    if (!alive()) return;

    for (let round = 1; round <= 3; round++) {
      let untangled = false;
      for (const step of twoOptSteps(graph, rowFor, seed.node, stopSigns, loop)) {
        untangled = true;
        refreshRoute();
        setStatus(`Untangling the route - pass ${step.pass}, saved ${Math.round(step.saved)} m`);
        scheduleDraw();
        await sleep(90);
        if (!alive()) return;
      }
      if (round === 1 && !untangled) {
        setStatus("No crossings - clean route");
        scheduleDraw();
        await sleep(500);
        if (!alive()) return;
      }

      if (mode !== "distance") break;
      const totals = refreshRoute();
      const added = greedyExtend(graph, rowFor, seed.node, stopSigns, totals.pathMeters, opts);
      if (!added) break;
      refreshRoute();
      setStatus(`Leftover budget - adding ${added} more sign${added > 1 ? "s" : ""}...`);
      scheduleDraw();
      await sleep(700);
      if (!alive()) return;
    }

    refreshRoute();
    els.summary.classList.remove("building");
    renderResult();
    fitToNodes(route.pathNodes);
    scheduleDraw();
  }

  function renderResult() {
    const km = route.totalMeters / 1000;
    els.summary.textContent =
      `${route.stopSigns.length} signs · ${km.toFixed(1)} km · ~${Math.round(km * MIN_PER_KM)} min`;
    els.actions.hidden = false;
    els.stops.innerHTML = "";
    if (!seed.isSign) {
      const li = document.createElement("li");
      li.className = "stop-start";
      li.textContent = `Start - ${seed.label}`;
      els.stops.appendChild(li);
    }
    for (const si of route.stopSigns) {
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
    if (els.loopBack.checked) {
      const li = document.createElement("li");
      li.className = "stop-start";
      li.textContent = `Finish - back at ${seed.label}`;
      els.stops.appendChild(li);
    }
    els.stops.hidden = false;
  }

  // ---------- GPX export ----------

  function xmlEscape(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  els.exportGpx.addEventListener("click", () => {
    if (!route || !graph) return;
    const lonOf = (n) => (graph.xs[n] / graph.kx).toFixed(6);
    const latOf = (n) => graph.ys[n].toFixed(6);
    const km = (route.totalMeters / 1000).toFixed(1);
    const name = `Sign Safari - ${route.stopSigns.length} signs, ${km} km`;

    const wpts = route.stopSigns.map((si, i) => {
      const s = graph.signs[si];
      return `  <wpt lat="${latOf(s.n)}" lon="${lonOf(s.n)}"><name>${i + 1}. ${xmlEscape(s.addr)}</name></wpt>`;
    });
    const trkpts = route.pathNodes.map(
      (n) => `      <trkpt lat="${latOf(n)}" lon="${lonOf(n)}"/>`
    );
    const gpx = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="Sign Safari" xmlns="http://www.topografix.com/GPX/1/1">',
      `  <metadata><name>${xmlEscape(name)}</name></metadata>`,
      ...wpts,
      "  <trk>",
      `    <name>${xmlEscape(name)}</name>`,
      "    <trkseg>",
      ...trkpts,
      "    </trkseg>",
      "  </trk>",
      "</gpx>",
      "",
    ].join("\n");

    const blob = new Blob([gpx], { type: "application/gpx+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sign-safari-${route.stopSigns.length}-signs.gpx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    showToast("GPX saved - import it as a course/route on your watch.");
  });

  // ---------- Lifecycle ----------

  new ResizeObserver(resize).observe(els.canvas);
  sliderConfig();
  els.budgetLabel.textContent = budgetText();

  let introSeen = false;
  try { introSeen = localStorage.getItem(INTRO_KEY) === "1"; } catch {}
  setStep(introSeen ? "start" : "intro");

  return {
    load,
    show() {
      els.view.hidden = false;
      if (currentStep() === "start" && !seed) els.hint.textContent = "You can also just tap a sign dot";
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
