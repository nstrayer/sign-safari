// localStorage-backed "seen" store with pub/sub.
// sg2026.seen  -> { "<id>": <epoch seconds marked>, ... }
// sg2026.codes -> { "<id>": "<code word from the physical sign>", ... }
// sg2026.settings -> { hideSeen, showBiz, showBadges }

const SEEN_KEY = "sg2026.seen";
const CODES_KEY = "sg2026.codes";
const SETTINGS_KEY = "sg2026.settings";
const VERSION_KEY = "sg2026.v";

const DEFAULT_SETTINGS = { hideSeen: false, showBiz: true, showBadges: false };

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const val = JSON.parse(raw);
    return val && typeof val === "object" ? val : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn("localStorage write failed", e);
  }
}

export function createStore() {
  let seen = readJson(SEEN_KEY, {});
  let codes = readJson(CODES_KEY, {});
  let settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_KEY, {}) };
  try { localStorage.setItem(VERSION_KEY, "1"); } catch {}

  const seenSubs = new Set();
  const settingsSubs = new Set();

  function notifySeen(id, isSeen) {
    for (const fn of seenSubs) fn(id, isSeen);
  }

  return {
    isSeen: (id) => Object.hasOwn(seen, id),
    seenAt: (id) => seen[id],
    count: () => Object.keys(seen).length,
    countToday() {
      const dayStart = new Date().setHours(0, 0, 0, 0) / 1000;
      return Object.values(seen).filter((t) => t >= dayStart).length;
    },
    all: () => ({ ...seen }),
    seenIds: () => Object.keys(seen),
    // Most recently marked first.
    recent(limit = 20) {
      return Object.entries(seen)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([id, at]) => ({ id, at }));
    },
    toggle(id) {
      const nowSeen = !Object.hasOwn(seen, id);
      if (nowSeen) seen[id] = Math.floor(Date.now() / 1000);
      else delete seen[id];
      writeJson(SEEN_KEY, seen);
      notifySeen(id, nowSeen);
      return nowSeen;
    },
    getCode: (id) => codes[id] ?? "",
    // Recording a code implies the sign was seen.
    setCode(id, code) {
      code = String(code ?? "").trim();
      if (code) {
        codes[id] = code;
        if (!Object.hasOwn(seen, id)) seen[id] = Math.floor(Date.now() / 1000);
      } else {
        delete codes[id];
      }
      writeJson(CODES_KEY, codes);
      writeJson(SEEN_KEY, seen);
      notifySeen(id, Object.hasOwn(seen, id));
    },
    codeCount: () => Object.keys(codes).length,
    // Codes ordered by when their sign was marked seen (oldest first).
    allCodes() {
      return Object.entries(codes)
        .map(([id, code]) => ({ id, code, at: seen[id] ?? 0 }))
        .sort((a, b) => a.at - b.at);
    },
    setSetting(key, value) {
      settings = { ...settings, [key]: value };
      writeJson(SETTINGS_KEY, settings);
      for (const fn of settingsSubs) fn(settings);
    },
    settings: () => ({ ...settings }),
    onSeenChange(fn) { seenSubs.add(fn); },
    onSettingsChange(fn) { settingsSubs.add(fn); },
    exportJson: () => JSON.stringify({ v: 1, seen, codes }),
    importJson(text) {
      const data = JSON.parse(text);
      const incoming = data && typeof data.seen === "object" && data.seen !== null ? data.seen : null;
      if (!incoming) throw new Error("Not a Sign Safari backup");
      const merged = { ...seen };
      let added = 0;
      for (const [id, at] of Object.entries(incoming)) {
        if (typeof at !== "number") continue;
        if (!Object.hasOwn(merged, id)) added++;
        merged[id] = merged[id] ? Math.min(merged[id], at) : at;
      }
      seen = merged;
      if (data.codes && typeof data.codes === "object") {
        for (const [id, code] of Object.entries(data.codes)) {
          if (typeof code === "string" && code.trim()) codes[id] = code.trim();
        }
        writeJson(CODES_KEY, codes);
      }
      writeJson(SEEN_KEY, seen);
      for (const id of Object.keys(incoming)) notifySeen(id, true);
      return added;
    },
  };
}
