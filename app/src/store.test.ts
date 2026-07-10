import { beforeEach, describe, expect, it } from "vitest";
import { createStore } from "./store";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

describe("unfinished walk storage", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
  });

  it("preserves a versioned route payload and the current visit index", () => {
    const store = createStore();
    const saved = { q: "v=2&d=%7B%22v%22%3A2%7D", at: 7 };
    store.saveWalk(saved);

    expect(createStore().savedWalk()).toEqual(saved);
  });

  it("keeps legacy route parameters restorable", () => {
    const store = createStore();
    const saved = { q: "r=101.biz-202&s=-83.7%2C42.2&l=1", at: 1 };
    store.saveWalk(saved);

    expect(createStore().savedWalk()).toEqual(saved);
  });
});
