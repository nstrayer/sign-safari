// localStorage-backed "seen" store with pub/sub.
// sg2026.seen  -> { "<id>": <epoch seconds marked>, ... }
// sg2026.settings -> { hideSeen, showBiz, showBadges }

const SEEN_KEY = "sg2026.seen";
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
    setSetting(key, value) {
      settings = { ...settings, [key]: value };
      writeJson(SETTINGS_KEY, settings);
      for (const fn of settingsSubs) fn(settings);
    },
    settings: () => ({ ...settings }),
    onSeenChange(fn) { seenSubs.add(fn); },
    onSettingsChange(fn) { settingsSubs.add(fn); },
    exportJson: () => JSON.stringify({ v: 1, seen }),
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
      writeJson(SEEN_KEY, seen);
      for (const id of Object.keys(incoming)) notifySeen(id, true);
      return added;
    },
  };
}
