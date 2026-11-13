// EA API handlers (docs/THIET-KE-HE-THONG.md §6, §8). Runtime-neutral: Web APIs only, so the same file
// runs in Supabase Edge Functions (Deno) and in the Node test suite. Each index.ts wires a handler to
// a service-role Supabase client.
//
// Request signing (both EAs):
//   X-QT-Token:     EA token issued by the dashboard (64 hex chars; the server stores only its SHA-256)
//   X-QT-Timestamp: Unix time in milliseconds
//   X-QT-Signature: hex HMAC-SHA256(hmac_secret, timestamp + "\n" + raw body)
// Requests more than MAX_SKEW_MS away from server time are refused (replay protection).

export type RpcResult = { data: unknown; error: { message: string; code?: string } | null };
export type Db = { rpc(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult> };
export type Account = { account_id: string; role: "master" | "receiver"; hmac_secret: string; disabled: boolean };
type Json = Record<string, unknown>;

export const MAX_SKEW_MS = 60_000;
export const MAX_BODY_BYTES = 512 * 1024;
export const MAX_WAIT_S = 20;

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** Wraps a handler: HttpError -> its status and code; anything else -> 500 without internals. */
export const route = (fn: (req: Request) => Promise<Response>) => async (req: Request) => {
  try {
    return await fn(req);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.code, message: e.message });
    console.error(e);
    return json(500, { error: "INTERNAL" });
  }
};

const enc = new TextEncoder();
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** "1.2.10" < "1.10.0" numerically. */
export function versionLess(a: string, b: string): boolean {
  const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

async function call(db: Db, fn: string, args: Json): Promise<unknown> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new HttpError(error.code === "42501" ? 403 : 500, "DB_ERROR", error.message);
  return data;
}

/** Verifies token, timestamp and signature; returns the account and the parsed JSON body. */
export async function authenticate(req: Request, db: Db, role: "master" | "receiver" | "any", now = Date.now()) {
  if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
  const token = req.headers.get("x-qt-token") ?? "";
  const ts = req.headers.get("x-qt-timestamp") ?? "";
  const sig = (req.headers.get("x-qt-signature") ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(token)) throw new HttpError(401, "TOKEN_INVALID");
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(now - t) > MAX_SKEW_MS) {
    throw new HttpError(401, "CLOCK_SKEW", "Đồng hồ máy chạy MT5 lệch quá 60 giây so với máy chủ.");
  }
  const text = await req.text();
  if (enc.encode(text).length > MAX_BODY_BYTES) throw new HttpError(413, "BODY_TOO_LARGE");
  const rows = (await call(db, "ct_auth", { p_token: token })) as Account[] | null;
  const account = Array.isArray(rows) ? rows[0] : null;
  if (!account) throw new HttpError(401, "TOKEN_INVALID");
  if (!safeEqual(await hmacHex(account.hmac_secret, ts + "\n" + text), sig)) throw new HttpError(401, "SIGNATURE_INVALID");
  if (role !== "any" && account.role !== role) throw new HttpError(403, "WRONG_ROLE", `Endpoint này dành cho tài khoản ${role}.`);
  if (account.disabled) throw new HttpError(403, "ACCOUNT_DISABLED", "Tài khoản đã bị tắt trên dashboard.");
  let body: Json;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "BAD_JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "BAD_JSON");
  return { account, body };
}

// ---------- validation (mirrors packages/shared/src/copytrade.js; a test keeps them equal) ----------
export const EVENT_TYPES = ["OPEN", "CLOSE", "PARTIAL_CLOSE", "MODIFY", "PENDING_PLACE", "PENDING_MODIFY", "PENDING_DELETE", "SNAPSHOT", "KILL"];
export const REQUIRED: Record<string, string[]> = {
  OPEN: ["master_ticket", "symbol", "side", "volume", "price", "master_equity"],
  CLOSE: ["master_ticket"],
  PARTIAL_CLOSE: ["master_ticket", "volume", "volume_before"],
  MODIFY: ["master_ticket"],
  PENDING_PLACE: ["master_ticket", "symbol", "side", "volume", "price"],
  PENDING_MODIFY: ["master_ticket"],
  PENDING_DELETE: ["master_ticket"],
  SNAPSHOT: ["positions"],
  KILL: [],
};
export const TASK_STATUSES = ["received", "validating", "risk_checked", "queued", "executing", "executed",
  "rejected", "retry_scheduled", "reconciliation_required", "failed"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Problems with one master event, or [] when it is valid. */
export function eventProblems(e: unknown): string[] {
  if (!e || typeof e !== "object") return ["not an object"];
  const x = e as Json;
  const out: string[] = [];
  if (typeof x.event_uid !== "string" || x.event_uid.length < 3 || x.event_uid.length > 96) out.push("event_uid");
  if (typeof x.type !== "string" || !EVENT_TYPES.includes(x.type)) return [...out, "type"];
  if (typeof x.ts_ms !== "number" || !(x.ts_ms > 0)) out.push("ts_ms");
  for (const k of REQUIRED[x.type]) if (x[k] === undefined || x[k] === null) out.push(k + " required");
  for (const k of ["volume", "volume_before", "price", "sl", "tp", "master_equity", "master_balance", "contract_size"]) {
    if (x[k] !== undefined && (typeof x[k] !== "number" || !Number.isFinite(x[k] as number) || (x[k] as number) < 0)) out.push(k);
  }
  if (x.type === "PARTIAL_CLOSE" && typeof x.volume === "number" && typeof x.volume_before === "number" && x.volume >= x.volume_before) {
    out.push("volume must be below volume_before");
  }
  if (x.positions !== undefined && (!Array.isArray(x.positions) || x.positions.length > 500)) out.push("positions");
  return out;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ---------- handlers ----------

/** POST /ct-heartbeat (both roles): live account state. */
export async function heartbeat(req: Request, db: Db, now = Date.now()) {
  const { account, body } = await authenticate(req, db, "any", now);
  const p: Json = {
    balance: num(body.balance), equity: num(body.equity), margin: num(body.margin), margin_level: num(body.margin_level),
    floating_pl: num(body.floating_pl), open_positions: num(body.open_positions),
    currency: typeof body.currency === "string" ? body.currency.slice(0, 8) : null,
    account_type: body.account_type === "hedging" || body.account_type === "netting" ? body.account_type : null,
    terminal_connected: typeof body.terminal_connected === "boolean" ? body.terminal_connected : null,
    trade_allowed: typeof body.trade_allowed === "boolean" ? body.trade_allowed : null,
    ea_version: typeof body.ea_version === "string" ? body.ea_version.slice(0, 16) : null,
    last_error: typeof body.last_error === "string" ? body.last_error.slice(0, 300) : null,
  };
  const r = (await call(db, "ct_heartbeat", { p_account: account.account_id, p })) as { min_ea_version?: string };
  const min = r?.min_ea_version ?? "0";
  if (versionLess(String(p.ea_version ?? "0"), min)) {
    return json(426, { error: "EA_OUTDATED", message: `Cần EA phiên bản ${min} trở lên.`, min_version: min });
  }
  return json(200, { ok: true, account_id: account.account_id, role: account.role, server_ms: now });
}

/** POST /ct-ingest (master): 1..100 events -> seq numbers. Duplicates keep their original seq. */
export async function ingest(req: Request, db: Db, now = Date.now()) {
  const { account, body } = await authenticate(req, db, "master", now);
  const events = body.events;
  if (!Array.isArray(events) || events.length < 1 || events.length > 100) throw new HttpError(400, "BAD_EVENTS", "events: 1..100");
  const problems = events.map((e, i) => ({ i, p: eventProblems(e) })).filter((x) => x.p.length);
  if (problems.length) return json(400, { error: "BAD_EVENTS", problems });
  const rows = (await call(db, "ct_append_events", { p_master: account.account_id, p_events: events })) as unknown[];
  return json(200, { accepted: rows ?? [], server_ms: now });
}

/**
 * POST /ct-pull (receiver): {cursors: {"<master_id>": seq}, wait_s}. Long-polls up to wait_s seconds
 * (max 20) and returns as soon as there is an event. Also returns the receiver's current link settings.
 */
export async function pull(req: Request, db: Db, now = Date.now(), sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  const { account, body } = await authenticate(req, db, "receiver", now);
  const cursors: Json = {};
  if (body.cursors && typeof body.cursors === "object") {
    for (const [k, v] of Object.entries(body.cursors as Json)) if (UUID.test(k) && typeof v === "number") cursors[k] = v;
  }
  const wait = Math.min(Math.max(Number(body.wait_s) || 0, 0), MAX_WAIT_S);
  const started = Date.now();
  let res: { events: unknown[]; cursors: Json };
  for (;;) {
    res = (await call(db, "ct_pull_batch", { p_receiver: account.account_id, p_cursors: cursors, p_limit: 200 })) as typeof res;
    if (res.events.length || Date.now() - started >= wait * 1000) break;
    await sleep(1000);
  }
  const links = await call(db, "ct_receiver_links", { p_receiver: account.account_id });
  return json(200, { server_ms: Date.now(), events: res.events, cursors: res.cursors, links });
}

/** POST /ct-ack (receiver): execution results, idempotent per (master, seq, master_ticket). */
export async function ack(req: Request, db: Db, now = Date.now()) {
  const { account, body } = await authenticate(req, db, "receiver", now);
  const results = body.results;
  if (!Array.isArray(results) || results.length < 1 || results.length > 200) throw new HttpError(400, "BAD_RESULTS", "results: 1..200");
  for (const [i, r] of results.entries()) {
    const x = r as Json;
    if (!x || typeof x.master_id !== "string" || !UUID.test(x.master_id) || typeof x.seq !== "number" ||
        typeof x.status !== "string" || !TASK_STATUSES.includes(x.status)) {
      throw new HttpError(400, "BAD_RESULTS", `results[${i}] needs master_id, seq and a valid status`);
    }
  }
  const stored = await call(db, "ct_ack", { p_receiver: account.account_id, p_results: results });
  return json(200, { stored });
}

/** POST /ct-bars (master): closed broker M1 bars for XAUUSD, XAGUSD, WTI, BRENT. */
export async function bars(req: Request, db: Db, now = Date.now()) {
  const { account, body } = await authenticate(req, db, "master", now);
  const list = body.bars;
  if (!Array.isArray(list) || list.length < 1 || list.length > 500) throw new HttpError(400, "BAD_BARS", "bars: 1..500");
  const stored = await call(db, "ct_push_bars", { p_master: account.account_id, p_bars: list });
  return json(200, { stored });
}
