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
    yahoo?: string; proxy?: string; broker?: boolean; binance?: string; coinbase?: string;
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
  export function chartSymbol(brokerSymbol: unknown): string | null;
  export function tfSeconds(tf: string): number;
}

declare module "@qt/core/series" {
  export function parseTf(tf: string): { n: number; unit: string; seconds: number };
  export function isIntraday(tf: string): boolean;
  export function resample(bars: Bar[], tf: string): Bar[];
  export function nativeBase(tf: string, natives: string[]): string | null;
}

declare module "@qt/core/indicators" {
  export type IndicatorInput = { key: string; label: string; type: string; default: unknown; min?: number; max?: number; options?: string[] };
  export type IndicatorOutput = { key: string; label: string; kind: "line" | "histogram"; color: string; dots?: boolean; lineWidth?: number };
  export type IndicatorDef = {
    id: string; name: string; group?: string; overlay: boolean; levels?: number[];
    inputs?: IndicatorInput[]; outputs?: IndicatorOutput[];
  };
  export type Marker = { time: number; position: string; shape: string; color: string; text?: string };
  export const INDICATORS: IndicatorDef[];
  export const BY_ID: Record<string, IndicatorDef>;
  export function defaults(id: string): Record<string, unknown>;
  export function compute(id: string, bars: Bar[], params?: Record<string, unknown>): Record<string, unknown> & { markers?: Marker[] };
}
