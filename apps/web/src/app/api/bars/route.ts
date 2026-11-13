import { NextResponse, type NextRequest } from "next/server";
import { SYMBOLS, TF_IDS, cacheSeconds } from "@qt/shared/market";
import { getBars } from "@/lib/market";

// GET /api/bars?symbol=XAUUSD&tf=1h&limit=500 — public market data, cached at the edge (design §4.2).
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const symbol = (q.get("symbol") ?? "").toUpperCase();
  const tf = q.get("tf") ?? "1h";
  const limit = Math.min(Math.max(Number(q.get("limit")) || 500, 2), 1500);
  if (!SYMBOLS[symbol]) return NextResponse.json({ error: `Symbol không hỗ trợ: ${symbol}` }, { status: 400 });
  if (!TF_IDS.includes(tf)) return NextResponse.json({ error: `Khung thời gian không hỗ trợ: ${tf}` }, { status: 400 });
  try {
    const out = await getBars(symbol, tf, limit);
    const s = cacheSeconds(tf);
    return NextResponse.json(out, {
      headers: { "Cache-Control": `public, s-maxage=${s}, stale-while-revalidate=${s * 6}` },
    });
  } catch (e) {
    const err = e as Error & { status?: number };
    return NextResponse.json({ error: err.message }, { status: err.status ?? 502, headers: { "Cache-Control": "no-store" } });
  }
}
