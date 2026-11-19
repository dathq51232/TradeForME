"use client";
import { useSyncExternalStore } from "react";
import type { Bar } from "./price-chart";

/**
 * The forming candle from the live stream, kept outside React state: it changes twice a second, and only the
 * components that show it (chart, price, brief) subscribe, instead of the whole chart page re-rendering.
 * `key` names the stream it came from, so a candle of another symbol or timeframe is never merged in.
 */
export type LiveState = { key: string; bar: Bar | null; at: number };

export function createLiveBar() {
  let state: LiveState = { key: "", bar: null, at: 0 };
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(key: string, bar: Bar) {
      state = { key, bar, at: Date.now() };
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => { subs.delete(f); };
    },
  };
}
export type LiveBarStore = ReturnType<typeof createLiveBar>;

/** A store that never ticks, for a chart without a live stream. */
export const NO_LIVE = createLiveBar();

export function useLiveBar(store: LiveBarStore) {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** The bars with the forming candle swapped in when it is the same candle; earlier bars keep their references. */
export function withLive(bars: Bar[], key: string, live: LiveState): Bar[] {
  const b = live.bar, n = bars.length;
  if (!b || !n || live.key !== key || b.time !== bars[n - 1].time || b === bars[n - 1]) return bars;
  return [...bars.slice(0, -1), b];
}
