// Minimal types for the plain-JS workspace packages used by the web app.
type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };

declare module "@qt/shared/copytrade" {
  export const LOT_MODES: string[];
  export const RISK_ACTIONS: string[];
  export const GROUP_STATES: string[];
  export const TASK_STATUSES: string[];
}

declare module "@qt/shared/market" {
  export type SymbolInfo = {
    name: string; group: string; digits: number;
    yahoo?: string; proxy?: string; broker?: boolean; binance?: string; coinbase?: string; futures?: string;
  };
  export const SYMBOLS: Record<string, SymbolInfo>;
  export const DEFAULT_WATCHLIST: string[];
  export const TIMEFRAMES: { tf: string; label: string; bars: number }[];
  export const TF_IDS: string[];
  export function cacheSeconds(tf: string): number;
  export const BINANCE_NATIVE: string[];
  export function binanceInterval(tf: string): string;
  export function parseBinance(rows: unknown[][]): Bar[];
  export const COINBASE_NATIVE: Record<string, number>;
  export function parseCoinbase(rows: number[][]): Bar[];
  export const YAHOO_NATIVE: Record<string, [string, string]>;
  export function parseYahoo(j: unknown, daily: boolean): Bar[];
  export function parseBrokerRows(rows: { ts: string; o: number | string; h: number | string; l: number | string; c: number | string; v: number | string }[]): Bar[];
  export function quoteFromDaily(bars: Bar[]): { price: number; change: number; changePct: number; time: number } | null;
  export function quoteFromTicker(j: unknown): { price: number; change: number; changePct: number; time: number } | null;
  export function tickerStreamUrl(info: SymbolInfo | undefined): string | null;
  export const USD_PROXY_TICKER: string;
  export function spotUsdFactor(mark: unknown, index: unknown, usdcUsdt: unknown): number | null;
  export function scaleBars<B extends Bar>(bars: B[], f: number | null | undefined): B[];
  export function fetchSpotUsdFactor(fetchFn: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>, ticker: string): Promise<number | null>;
  export const BINANCE_SPOT_HOST: string;
  export const BINANCE_SPOT_STREAM: string;
  export const BINANCE_FUTURES_HOST: string;
  export const BINANCE_FUTURES_STREAM: string;
  export const FUTURES_MAX_TF_SECONDS: number;
  export function usesFutures(info: SymbolInfo | undefined, tf: string): boolean;
  export function chartSymbol(brokerSymbol: unknown): string | null;
  export function tfSeconds(tf: string): number;
}

declare module "@qt/core/trend" {
  export type TrendState = "up" | "down" | "side";
  export const FAST: number;
  export const SLOW: number;
  export const TREND_LABEL: Record<TrendState, string>;
  export type TrendSummary = {
    state: TrendState; label: string; since: number; bars: number; close: number; emaFast: number; emaSlow: number;
    distPct: number; slopePct: number | null; high52: number; low52: number; time: number;
  };
  export function trendSummary(bars: Bar[], fast?: number, slow?: number): TrendSummary | null;
  export function trendChanges(bars: Bar[], fast?: number, slow?: number): { type: "trend" | "cross" | "ema200"; id: string; dir: number; state?: TrendState }[];
}

declare module "@qt/core/elliott" {
  export type WavePoint = { i: number; time: number; price: number; label: string; provisional: boolean };
  export type ElliottCount = {
    dir: 1 | -1; stage: "w3" | "w4" | "w5" | "A" | "B" | "C"; text: string; score: number;
    points: WavePoint[]; target: { price: number; label: string } | null;
    /** which swing filter gave the count: 0 small, 1 medium, 2 large waves */
    degree: number;
    /** RSI lower at the end of 5 than at 3 (up impulse); null before wave 5 */
    divergence: boolean | null;
    /** the line through the ends of waves 2 and 4, from (4) on */
    line24: { a: { time: number; price: number }; b: { time: number; price: number } } | null;
    /** a close beyond the 2-4 line after wave 5 (the impulse is over); null before wave 5 */
    endConfirmed: boolean | null;
  };
  export function elliottWaves(bars: Bar[], opts?: { depth?: number; minAtr?: number; upOnly?: boolean; pick?: "newest" | "best"; minScore?: number; anchor?: number; bMax?: number; minDegree?: number }): ElliottCount | null;
  export function wavePivots(bars: Bar[], opts?: { depth?: number; minAtr?: number }): { i: number; time: number; price: number; kind: "H" | "L"; provisional?: boolean }[];
}
declare module "@qt/core/series" {
  export function parseTf(tf: string): { n: number; unit: string; seconds: number };
  export function isIntraday(tf: string): boolean;
  /** Start (UTC seconds) of the bucket of timeframe `tf` that time `t` falls in. */
  export function bucketStart(t: number, tf: string): number;
  export function resample(bars: Bar[], tf: string): Bar[];
  export function nativeBase(tf: string, natives: string[]): string | null;
}

declare module "@qt/core/patterns" {
  type P = { t: number; p: number };
  export type PatternStatus = "forming" | "breakoutUp" | "breakoutDown" | "expired";
  export type ChartPattern = {
    kind: string; name: string; bias: -1 | 0 | 1; status: PatternStatus; start: number; end: number; target: number | null;
    lines: { role: "upper" | "lower" | "path" | "neck"; a: P; b: P }[]; label: P;
  };
  export type CandlePattern = { i: number; time: number; kind: string; name: string; bias: -1 | 0 | 1 };
  export type CloseLevel = { price: number; swings: number; touches: number; first: number; last: number; strength: 1 | 2 | 3; side: "support" | "resistance" };
  export type PeriodClose = { period: "day" | "week" | "month"; label: string; price: number; time: number };
  export type Session = { id: string; name: string; color: string; start: number; end: number };
  export const SESSIONS: { id: string; name: string; tz: string; open: number; close: number; color: string }[];
  export function swingPivots(bars: Bar[], depth?: number): { i: number; time: number; price: number; kind: "H" | "L" }[];
  export function chartPatterns(bars: Bar[], opts?: { depth?: number; max?: number }): ChartPattern[];
  export type MicroWedge = {
    kind: "microWedgeDown" | "microWedgeUp"; name: string; bias: -1 | 1;
    status: "forming" | "ready" | "breakoutUp" | "breakoutDown" | "failed" | "expired";
    stage: "forming" | "ready" | "broken" | "failed" | "expired"; score: number; reasons: string[];
    start: number; end: number; apex: number; target: number | null; entry: number | null; stop: number | null; tp1: number | null;
    lines: { role: "upper" | "lower" | "path" | "support"; a: P; b: P }[]; label: P;
  };
  export const MICRO_WEDGE_NAMES: Record<MicroWedge["kind"], string>;
  export function microWedges(bars: Bar[], opts?: {
    depth?: number; lookback?: number; impulseAtr?: number; maxImpulseBars?: number; readyScore?: number; max?: number; levels?: number[];
  }): MicroWedge[];
  export function candlestickPatterns(bars: Bar[], opts?: { doji?: boolean }): CandlePattern[];
  export function closeLevels(bars: Bar[], opts?: { lookback?: number; max?: number; depth?: number }): CloseLevel[];
  export function periodCloses(bars: Bar[]): PeriodClose[];
  export function sessionsBetween(from: number, to: number): Session[];
  export function sessionStatus(now: number): { open: { id: string; name: string; color: string; end: number }[]; next: { name: string; kind: "open" | "close"; at: number } | null };
}

declare module "@qt/core/indicators" {
  export type IndicatorInput = { key: string; label: string; type: string; default: unknown; min?: number; max?: number; options?: string[] };
  export type IndicatorOutput = {
    key: string; label: string; kind: "line" | "histogram"; color: string; dots?: boolean; lineWidth?: number;
    /** 0 solid, 1 dotted, 2 dashed */ lineStyle?: number;
    /** no axis label or title, and no series at all when it has no values (trendline slots) */ quiet?: boolean;
    /** draw on the price pane although the indicator has its own pane */ pane?: "price";
  };
  export type IndicatorDef = {
    id: string; name: string; group?: string; overlay: boolean; levels?: number[];
    inputs?: IndicatorInput[]; outputs?: IndicatorOutput[];
  };
  export type Marker = { time: number; position: string; shape: string; color: string; text?: string };
  export const INDICATORS: IndicatorDef[];
  export const BY_ID: Record<string, IndicatorDef>;
  export function defaults(id: string): Record<string, unknown>;
  export function compute(id: string, bars: Bar[], params?: Record<string, unknown>): Record<string, unknown> & { markers?: Marker[]; priceMarkers?: Marker[] };
  export function ema(src: number[], n: number): number[];
  export function rsiOf(src: number[], n?: number): number[];
}

declare module "@qt/core/signal-test" {
  export type SignalKind = "wave4" | "top" | "waveC" | "resume" | "wedge" | "pattern";
  export type Signal = {
    kind: SignalKind; key: string; label: string; dir: 1 | -1; hit: number; fail: number; degree?: number;
    time: number; i: number; close: number; base: number;
    outcome: "hit" | "miss" | "open" | "expired"; at: number | null; resolvedTime: number | null;
  };
  export type KindSummary = { n: number; hit: number; miss: number; open: number; rate: number | null; base: number | null; edge: number | null; bars: number | null };
  export type SignalTestResult = { signals: Signal[]; summary: Partial<Record<SignalKind, KindSummary>>; repaints: number; repaintPer100: number | null; steps: number };
  export type SignalTestOptions = {
    detectors?: ("elliott" | "wedges" | "patterns")[]; warmup?: number; every?: number; horizon?: number;
    elliott?: { depth?: number; minAtr?: number; upOnly?: boolean };
    predict?: { topNeedsDivergence?: boolean; topAfter24?: boolean; cAfterB?: boolean };
    onProgress?: (t: number) => void;
  };
  export const SIGNAL_KINDS: Record<SignalKind, string>;
  export function signalTest(bars: Bar[], opts?: SignalTestOptions): SignalTestResult;
  export function summarize(signals: Signal[]): Partial<Record<SignalKind, KindSummary>>;
}

declare module "@qt/core/backtest" {
  export type Operand = number | string | { line: { t1: number; p1: number; t2: number; p2: number; extend?: "none" | "right" | "both" } };
  export type Condition = { left: Operand; op: string; right: Operand };
  export type Strategy = {
    name?: string;
    indicators?: Record<string, { id: string; params?: Record<string, unknown>; output?: string }>;
    entryLong?: Condition[]; exitLong?: Condition[]; entryShort?: Condition[]; exitShort?: Condition[];
    exitMatch?: "all" | "any"; maxBarsInTrade?: number;
    stopLossPct?: number; takeProfitPct?: number; trailingStopPct?: number;
    initialCapital?: number; positionPct?: number; feePct?: number; slippagePct?: number; spreadPct?: number;
    intrabar?: "worst" | "ohlc" | "magnifier";
  };
  export type Trade = {
    side: "long" | "short"; entryTime: number; exitTime: number; entryPrice: number; exitPrice: number; qty: number;
    pnl: number; pnlPct: number; bars: number; entryReason: string; exitReason: string;
  };
  export type Stats = {
    netProfit: number | null; netProfitPct: number | null; buyHoldPct: number | null; cagrPct: number | null;
    totalTrades: number; winRatePct: number | null; profitFactor: number | null; maxDrawdownPct: number | null;
    avgTradePct: number | null; avgWinPct: number | null; avgLossPct: number | null; largestWin: number | null; largestLoss: number | null;
    sharpe: number | null; sortino: number | null; exposurePct: number | null; feesAndSlippage: string; fills?: string;
  };
  export const OPS: string[];
  export const EXAMPLE_STRATEGIES: Record<string, Strategy>;
  export function backtest(bars: Bar[], strategy: Strategy, opts?: { subBars?: Bar[] | null }): { trades: Trade[]; equity: { time: number; value: number }[]; stats: Stats };
  export function tradesCsv(trades: Trade[]): string;
}
