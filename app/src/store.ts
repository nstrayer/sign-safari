// localStorage-backed "seen" store with pub/sub.
// sg2026.seen  -> { "<id>": <epoch seconds marked>, ... }
// sg2026.codes -> { "<id>": "<code word from the physical sign>", ... }
// sg2026.settings -> { hideSeen, showBiz, showBadges }
// sg2026.welcomed -> "1" once the intro modal has been dismissed

const SEEN_KEY = "sg2026.seen";
const CODES_KEY = "sg2026.codes";
const SETTINGS_KEY = "sg2026.settings";
const VERSION_KEY = "sg2026.v";
const WELCOMED_KEY = "sg2026.welcomed";

export interface Settings {
  hideSeen: boolean;
  showBiz: boolean;
  showBadges: boolean;
}

export type SeenListener = (id: string, isSeen: boolean) => void;
export type SettingsListener = (settings: Settings) => void;

export interface Store {
  isSeen(id: string): boolean;
  seenAt(id: string): number | undefined;
  count(): number;
  countToday(): number;
  all(): Record<string, number>;
  seenIds(): string[];
  /** Most recently marked first. */
  recent(limit?: number): { id: string; at: number }[];
  toggle(id: string): boolean;
  getCode(id: string): string;
  /** Recording a code implies the sign was seen. */
  setCode(id: string, code: string): void;
  codeCount(): number;
  /** Codes ordered by when their sign was marked seen (oldest first). */
  allCodes(): { id: string; code: string; at: number }[];
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void;
  settings(): Settings;
  wasWelcomed(): boolean;
  setWelcomed(): void;
  onSeenChange(fn: SeenListener): void;
  onSettingsChange(fn: SettingsListener): void;
  exportJson(): string;
  /** Merges a backup; returns how many new ids were added. Throws on junk. */
  importJson(text: string): number;
}

const DEFAULT_SETTINGS: Settings = { hideSeen: false, showBiz: true, showBadges: false };

function readJson<T extends object>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const val: unknown = JSON.parse(raw);
    return val && typeof val === "object" ? (val as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: object): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn("localStorage write failed", e);
  }
}

export function createStore(): Store {
  let seen = readJson<Record<string, number>>(SEEN_KEY, {});
  const codes = readJson<Record<string, string>>(CODES_KEY, {});
  let settings: Settings = { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(SETTINGS_KEY, {}) };
  try { localStorage.setItem(VERSION_KEY, "1"); } catch {}

  const seenSubs = new Set<SeenListener>();
  const settingsSubs = new Set<SettingsListener>();

  function notifySeen(id: string, isSeen: boolean): void {
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
    wasWelcomed() {
      try { return localStorage.getItem(WELCOMED_KEY) === "1"; } catch { return true; }
    },
    setWelcomed() {
      try { localStorage.setItem(WELCOMED_KEY, "1"); } catch {}
    },
    onSeenChange(fn) { seenSubs.add(fn); },
    onSettingsChange(fn) { settingsSubs.add(fn); },
    exportJson: () => JSON.stringify({ v: 1, seen, codes }),
    importJson(text) {
      const data: unknown = JSON.parse(text);
      if (!data || typeof data !== "object") throw new Error("Not a Sign Safari backup");
      const backup = data as { seen?: unknown; codes?: unknown };
      if (!backup.seen || typeof backup.seen !== "object") throw new Error("Not a Sign Safari backup");
      const incoming = backup.seen as Record<string, unknown>;
      const merged = { ...seen };
      let added = 0;
      for (const [id, at] of Object.entries(incoming)) {
        if (typeof at !== "number") continue;
        if (!Object.hasOwn(merged, id)) added++;
        merged[id] = merged[id] ? Math.min(merged[id], at) : at;
      }
      seen = merged;
      if (backup.codes && typeof backup.codes === "object") {
        for (const [id, code] of Object.entries(backup.codes as Record<string, unknown>)) {
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
