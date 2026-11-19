// Runs the walk-forward test of the automatic readings off the main thread: it re-reads the chart at every bar,
// which takes a second or more on 1500 bars, and the page must stay usable meanwhile.
import { signalTest, type SignalTestOptions } from "@qt/core/signal-test";

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };

self.onmessage = (e: MessageEvent<{ bars: Bar[]; opts: Omit<SignalTestOptions, "onProgress"> }>) => {
  const { bars, opts } = e.data;
  let last = 0;
  try {
    const result = signalTest(bars, {
      ...opts,
      onProgress: (t) => {
        if (t - last < 25) return;
        last = t;
        self.postMessage({ progress: t / bars.length });
      },
    });
    self.postMessage({ result });
  } catch (err) {
    self.postMessage({ error: (err as Error).message });
  }
};
