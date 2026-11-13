//+------------------------------------------------------------------+
//| QT/SelfTest.mqh — checks that this terminal computes signatures, |
//| JSON and lot sizes exactly like the server and packages/shared.  |
//| Both EAs run it at start-up and report the result to the         |
//| dashboard; Scripts/QT_SelfTest prints every line.                |
//+------------------------------------------------------------------+
#property strict

#include "Api.mqh"
#include "Lot.mqh"

int    g_stFail = 0;
string g_stFailed = "";
bool   g_stVerbose = false;
void Check(bool ok, const string name)
  {
   if(g_stVerbose) Print(ok ? "OK   " : "FAIL ", name);
   if(!ok) { g_stFail++; g_stFailed += (g_stFailed == "" ? "" : ", ") + name; }
  }
bool Near(double a, double b) { return MathAbs(a - b) < 1e-9; }

// fills by reference: structures with strings are not returned by value
void Base(QTLotArgs &a, const string mode, double value, double masterLot)
  {
   a.mode = mode; a.value = value; a.masterLot = masterLot;
   a.masterBalance = 0; a.masterEquity = 0; a.receiverBalance = 0; a.receiverEquity = 0;
   a.masterContractSize = 0; a.receiverContractSize = 0; a.slDistance = 0; a.tickSize = 0; a.tickValue = 0;
   a.volMin = 0.01; a.volMax = 100; a.volStep = 0.01; a.maxLot = 0; a.minLot = 0; a.belowMin = "skip";
  }

//--- "ok", or "fail: <names of the failed checks>"
string QTSelfTest(const bool verbose)
  {
   g_stFail = 0; g_stFailed = ""; g_stVerbose = verbose;
   // HMAC-SHA256: RFC 4231-style vector, and the exact construction the server verifies (Node crypto)
   Check(QTHmacSha256Hex("key", "The quick brown fox jumps over the lazy dog") == "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8", "HMAC vector");
   string secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
   Check(QTHmacSha256Hex(secret, "1794567890000\n{\"events\":[{\"type\":\"KILL\"}]}") == "646ff1c070098e6a2ccf658c71c8b943c76fb18a089ea4e3b891a058184218d2", "HMAC matches server");

   // connection code from the dashboard
   string cu, ct, cs;
   string code = "QT1.abcdefghijklmnopqrst." + secret + "." + secret;
   Check(QTParseConnection(" " + code + " ", cu, ct, cs) && cu == "https://abcdefghijklmnopqrst.supabase.co/functions/v1" && ct == secret && cs == secret, "connection code");
   Check(!QTParseConnection("QT1.abc.def", cu, ct, cs), "bad connection code refused");

   // JSON
   CQJ j;
   Check(j.Parse("{\"a\":1.5,\"b\":\"x\\\"y\",\"c\":[1,{\"d\":true}],\"e\":null,\"seq\":1234567890123}"), "JSON parse");
   Check(Near(j.Num("a"), 1.5) && j.Str("b") == "x\"y" && j.Get("c").Size() == 2 && j.Get("c").At(1).Bool("d") && !j.Has("e"), "JSON values");
   Check(j.Long("seq") == 1234567890123, "JSON large integer");
   Check(JStr("a\"b\\") == "\"a\\\"b\\\\\"" && JNum(0.5) == "0.5" && JNum(2) == "2", "JSON writer");

   // Lot sizing (same cases as packages/shared/test/copytrade.test.js)
   string skip;
   QTLotArgs a;
   Base(a, "equity_ratio", 1, 0.5); a.masterEquity = 10000; a.receiverEquity = 3333;
   Check(Near(QTComputeLot(a, skip), 0.16), "equity_ratio rounds down");
   Base(a, "multiplier", 10, 1); a.maxLot = 3;
   Check(Near(QTComputeLot(a, skip), 3), "max_lot cap");
   Base(a, "equity_ratio", 1, 0.01); a.masterEquity = 10000; a.receiverEquity = 500;
   Check(QTComputeLot(a, skip) == 0 && skip == "BELOW_MIN_LOT", "below min skipped");
   a.belowMin = "min_lot";
   Check(Near(QTComputeLot(a, skip), 0.01), "below min -> min lot");
   Base(a, "multiplier", 1, 0.1); a.masterContractSize = 100; a.receiverContractSize = 1; a.volMin = 1; a.volMax = 1000; a.volStep = 1;
   Check(Near(QTComputeLot(a, skip), 10), "contract size conversion");
   Base(a, "risk_percent", 1, 1); a.receiverEquity = 10000; a.tickSize = 0.01; a.tickValue = 1; a.slDistance = 10;
   Check(Near(QTComputeLot(a, skip), 0.1), "risk_percent");
   a.slDistance = 0;
   Check(QTComputeLot(a, skip) == 0 && skip == "NO_STOP_LOSS", "risk_percent needs SL");
   Base(a, "balance_ratio", 1, 0.5); a.masterBalance = 10000; a.receiverBalance = 5000;
   Check(Near(QTComputeLot(a, skip), 0.25), "balance_ratio");
   Base(a, "multiplier", 0.1, 0.5); a.minLot = 0.1;
   Check(QTComputeLot(a, skip) == 0 && skip == "BELOW_MIN_LOT", "link min_lot floor");

   // partial close and staleness
   Check(Near(QTPartialCloseVolume(0.25, 0.5, 0.3, 0.01, 0.01), 0.15), "partial close fraction");
   Check(Near(QTPartialCloseVolume(0.9, 1, 0.05, 0.01, 0.01), 0.05), "partial close leaves no dust");
   Check(QTIsStale("OPEN", 1, 11001, 10) && !QTIsStale("OPEN", 1, 9001, 10) && !QTIsStale("CLOSE", 1, 999000, 10), "stale rules");

   // filters
   CQJ s, e;
   s.Parse("{\"copy_buy\":false,\"copy_sell\":true,\"reverse\":false,\"copy_pending\":false}");
   e.Parse("{\"type\":\"OPEN\",\"symbol\":\"XAUUSD\",\"side\":\"BUY\"}");
   Check(QTFilterReason(GetPointer(e), GetPointer(s), NULL) == "BUY_DISABLED", "filter: buy disabled");

   return g_stFail == 0 ? "ok" : "fail: " + g_stFailed;
  }
//+------------------------------------------------------------------+
