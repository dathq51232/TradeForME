//+------------------------------------------------------------------+
//| QT/Lot.mqh — MQL5 port of packages/shared/src/copytrade.js:       |
//| computeLot, mapSymbol, partialCloseVolume, isStale, filterReason, |
//| riskPreCheck. Must give the same results as the JS tests          |
//| (Scripts/QT_SelfTest.mq5 checks the main cases in the terminal).  |
//+------------------------------------------------------------------+
#property strict

#include "Json.mqh"

int QTStepDigits(double step)
  {
   int d = 0;
   while(d < 8 && MathAbs(step * MathPow(10, d) - MathRound(step * MathPow(10, d))) > 1e-9) d++;
   return d;
  }

struct QTLotArgs
  {
   string            mode;          // fixed | multiplier | balance_ratio | equity_ratio | risk_percent
   double            value;
   double            masterLot;
   double            masterBalance;
   double            masterEquity;
   double            receiverBalance;
   double            receiverEquity;
   double            masterContractSize;
   double            receiverContractSize;
   double            slDistance;
   double            tickSize;
   double            tickValue;
   double            volMin;
   double            volMax;
   double            volStep;
   double            maxLot;        // 0 = none
   double            minLot;        // 0 = none
   string            belowMin;      // skip | min_lot
  };

//--- lot > 0, or 0 with skip set to the reason
double QTComputeLot(const QTLotArgs &a, string &skip)
  {
   skip = "";
   double adj = (a.masterContractSize > 0 && a.receiverContractSize > 0) ? a.masterContractSize / a.receiverContractSize : 1.0;
   double raw = 0;
   if(a.mode == "fixed") raw = a.value;
   else if(a.mode == "multiplier") raw = a.masterLot * a.value * adj;
   else if(a.mode == "balance_ratio")
     {
      if(!(a.masterBalance > 0) || !(a.receiverBalance > 0)) { skip = "BALANCE_UNKNOWN"; return 0; }
      raw = a.masterLot * (a.receiverBalance / a.masterBalance) * a.value * adj;
     }
   else if(a.mode == "equity_ratio")
     {
      if(!(a.masterEquity > 0) || !(a.receiverEquity > 0)) { skip = "EQUITY_UNKNOWN"; return 0; }
      raw = a.masterLot * (a.receiverEquity / a.masterEquity) * a.value * adj;
     }
   else if(a.mode == "risk_percent")
     {
      if(!(a.slDistance > 0)) { skip = "NO_STOP_LOSS"; return 0; }
      if(!(a.receiverEquity > 0) || !(a.tickSize > 0) || !(a.tickValue > 0)) { skip = "SYMBOL_INFO_MISSING"; return 0; }
      double lossPerLot = (a.slDistance / a.tickSize) * a.tickValue;
      raw = (a.receiverEquity * a.value) / 100.0 / lossPerLot;
     }
   else { skip = "BAD_LOT_MODE"; return 0; }

   if(!MathIsValidNumber(raw) || raw <= 0) { skip = "BAD_LOT"; return 0; }
   double cap = a.volMax;
   if(a.maxLot > 0 && a.maxLot < cap) cap = a.maxLot;
   int d = QTStepDigits(a.volStep);
   double lot = MathFloor(raw / a.volStep + 1e-9) * a.volStep;   // round down: never trade more than asked
   lot = NormalizeDouble(MathMin(lot, cap), d);
   double floorLot = MathMax(a.volMin, a.minLot);
   if(lot < floorLot - 1e-12)
     {
      double m = NormalizeDouble(MathCeil(floorLot / a.volStep - 1e-9) * a.volStep, d);
      if(a.belowMin == "min_lot" && m <= cap + 1e-12) return m;
      skip = "BELOW_MIN_LOT";
      return 0;
     }
   return lot;
  }

//--- receiver volume for a master partial close: same fraction, rounded to step, never leaves dust
double QTPartialCloseVolume(double masterClosed, double masterBefore, double receiverVolume, double step, double vmin)
  {
   double frac = masterClosed / masterBefore;
   int d = QTStepDigits(step);
   double v = NormalizeDouble(MathRound((receiverVolume * frac) / step) * step, d);
   if(v < vmin) v = 0;
   if(receiverVolume - v < vmin) v = receiverVolume;
   return v;
  }

//--- opens older than maxAgeS are refused; exits always apply
bool QTIsStale(const string type, long tsMs, long nowMs, int maxAgeS)
  {
   if(type == "CLOSE" || type == "PARTIAL_CLOSE" || type == "KILL" || type == "MODIFY" || type == "PENDING_DELETE") return false;
   return nowMs - tsMs > (long)maxAgeS * 1000;
  }

bool QTSymbolExists(const string name)
  {
   bool custom = false;
   return SymbolExist(name, custom);
  }

//--- receiver symbol: explicit map, then exact/common suffixes, then case-insensitive; "" if none
string QTMapSymbol(const string masterSymbol, CQJ *map)
  {
   if(map != NULL && map.type == QJ_OBJ && map.Str(masterSymbol) != "") return map.Str(masterSymbol);
   string suffixes[] = {"", "m", ".m", ".r", "#", ".pro", "pro", ".a", "-ecn", ".ecn", "+", ".cash", "_i"};
   string base = masterSymbol;
   string strip[] = {".cash", ".pro", ".ecn", "-ecn", ".m", ".r", ".a", "_i", "pro", "#", "+", "m"};
   for(int i = 0; i < ArraySize(strip); i++)
     {
      int L = StringLen(strip[i]);
      if(StringLen(base) > L + 3 && StringSubstr(base, StringLen(base) - L) == strip[i]) { base = StringSubstr(base, 0, StringLen(base) - L); break; }
     }
   string roots[2];
   roots[0] = masterSymbol;
   roots[1] = base;
   for(int r = 0; r < 2; r++)
      for(int i = 0; i < ArraySize(suffixes); i++)
         if(QTSymbolExists(roots[r] + suffixes[i])) return roots[r] + suffixes[i];
   string up = masterSymbol, upBase = base;
   StringToUpper(up);
   StringToUpper(upBase);
   for(int i = 0; i < SymbolsTotal(false); i++)
     {
      string s = SymbolName(i, false), su = s;
      StringToUpper(su);
      if(su == up || su == upBase) return s;
     }
   return "";
  }

bool QTListHas(CQJ *list, const string s)
  {
   if(list == NULL || list.type != QJ_ARR || list.Size() == 0) return true; // no list = everything allowed
   for(int i = 0; i < list.Size(); i++) if(list.At(i).s == s) return true;
   return false;
  }

//--- per-receiver filters; "" = copy, otherwise the reason (mirrors filterReason)
string QTFilterReason(CQJ *e, CQJ *s, CQJ *groupSymbols)
  {
   string type = e.Str("type");
   if(type == "KILL" || type == "SNAPSHOT") return "";
   string side = e.Str("side");
   string dir = side == "" ? "" : (StringFind(side, "BUY") == 0 ? "BUY" : "SELL");
   if(type == "OPEN" || type == "PENDING_PLACE")
     {
      if(!QTListHas(groupSymbols, e.Str("symbol")) || !QTListHas(s.Get("allowed_symbols"), e.Str("symbol"))) return "SYMBOL_NOT_ALLOWED";
      string eff = (s.Bool("reverse") && dir != "") ? (dir == "BUY" ? "SELL" : "BUY") : dir;
      if(eff == "BUY" && !s.Bool("copy_buy", true)) return "BUY_DISABLED";
      if(eff == "SELL" && !s.Bool("copy_sell", true)) return "SELL_DISABLED";
     }
   if(type == "OPEN" && !s.Bool("copy_market", true)) return "MARKET_DISABLED";
   if(StringFind(type, "PENDING_") == 0 && !s.Bool("copy_pending", false)) return "PENDING_DISABLED";
   if(type == "CLOSE" && !s.Bool("copy_close", true)) return "CLOSE_DISABLED";
   if(type == "PARTIAL_CLOSE" && !s.Bool("copy_partial_close", true)) return "PARTIAL_CLOSE_DISABLED";
   if(type == "MODIFY" && (!s.Bool("copy_modify", true) || !s.Bool("copy_sl_tp", true))) return "MODIFY_DISABLED";
   return "";
  }

struct QTRiskCtx
  {
   bool              online;
   bool              tradeAllowed;
   double            lot;
   double            spreadPoints;
   int               openPositions;
   double            openLots;
   double            dayStartEquity;
   double            peakEquity;
   double            equity;
   double            marginAfter;
   double            freeMarginAfter;
  };

//--- pre-trade risk checks for a new position; "" = ok, otherwise the rule (mirrors riskPreCheck)
string QTRiskCheck(CQJ *s, const QTRiskCtx &c, string &action)
  {
   action = s.Str("risk_action", "reject");
   if(!c.online) { action = "reject"; return "RECEIVER_OFFLINE"; }
   if(!c.tradeAllowed) { action = "reject"; return "TRADE_DISABLED"; }
   if(c.freeMarginAfter < 0) return "INSUFFICIENT_MARGIN";
   if(s.Has("max_spread_points") && c.spreadPoints > s.Num("max_spread_points")) return "SPREAD_TOO_HIGH";
   if(s.Has("max_lot") && c.lot > s.Num("max_lot")) return "MAX_LOT";
   if(s.Has("max_open_positions") && c.openPositions + 1 > s.Num("max_open_positions")) return "MAX_OPEN_POSITIONS";
   if(s.Has("max_exposure_lots") && c.openLots + c.lot > s.Num("max_exposure_lots") + 1e-9) return "MAX_EXPOSURE";
   if(s.Has("max_daily_loss_pct") && c.dayStartEquity > 0 && (c.dayStartEquity - c.equity) / c.dayStartEquity * 100.0 >= s.Num("max_daily_loss_pct")) return "MAX_DAILY_LOSS";
   if(s.Has("max_drawdown_pct") && c.peakEquity > 0 && (c.peakEquity - c.equity) / c.peakEquity * 100.0 >= s.Num("max_drawdown_pct")) return "MAX_DRAWDOWN";
   if(s.Has("max_margin_usage_pct") && c.equity > 0 && c.marginAfter / c.equity * 100.0 > s.Num("max_margin_usage_pct")) return "MAX_MARGIN_USAGE";
   action = "";
   return "";
  }
//+------------------------------------------------------------------+
