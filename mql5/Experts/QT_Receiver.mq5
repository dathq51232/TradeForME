//+------------------------------------------------------------------+
//| QT_Receiver.mq5 — copies trades from the linked master(s).        |
//|                                                                  |
//| Long-polls /ct-pull, applies filters, lot sizing and risk limits  |
//| configured on the dashboard, trades, and reports every result to  |
//| /ct-ack. Positions are tagged magic = per master, comment          |
//| "QT#<master ticket>", so a restart never opens duplicates.        |
//|                                                                  |
//| Setup: attach to ONE chart, on its own terminal for this account. |
//| Allow WebRequest for the API URL. WebRequest blocks the EA while  |
//| it waits (up to InpPollWaitSec), which is expected.               |
//+------------------------------------------------------------------+
#property copyright "Quant Terminal Cloud (MIT)"
#property version   "1.00"
#property strict

#include <Trade\Trade.mqh>
#include <QT\Api.mqh>
#include <QT\Lot.mqh>

input string InpConnection   = "";      // Mã kết nối (dán từ trang Tài khoản MT5)
input int    InpPollWaitSec  = 20;      // long-poll wait (s, max 20)
input int    InpHeartbeatSec = 30;      // heartbeat (s)
input int    InpSnapshotMaxAgeSec = 15; // reconcile only against snapshots younger than this (s)
input group "Nâng cao (để trống nếu đã có mã kết nối)"
input string InpApiUrl       = "";      // API URL
input string InpToken        = "";      // EA token
input string InpSecret       = "";      // HMAC secret

CQTApi   g_api;
CTrade   g_trade;
long     g_login;
string   g_curMaster[];                 // cursors: master id -> last processed seq
long     g_curSeq[];
string   g_acks[];                      // results not yet delivered to /ct-ack
string   g_reported[];                  // "master:ticket" discrepancies already reported this session
string   g_skipped[];                   // "master:ticket" opens we deliberately did not copy
datetime g_lastHeartbeat = 0;
datetime g_lastPullOk = 0;
string   g_status = "";
int      g_done = 0, g_failed = 0;
CQJ     *g_doc = NULL;                  // last /ct-pull response (owns the link settings)
CQJ     *g_links = NULL;

//+------------------------------------------------------------------+
int OnInit()
  {
   g_login = AccountInfoInteger(ACCOUNT_LOGIN);
   string setupError = QTSetup(g_api, InpConnection, InpApiUrl, InpToken, InpSecret);
   if(setupError != "")
     {
      Alert("QT Receiver: ", setupError);
      return INIT_PARAMETERS_INCORRECT;
     }
   LoadCursors();
   g_trade.SetAsyncMode(false);
   if(QTStartupCheck(g_api, "QT Receiver")) g_lastHeartbeat = TimeLocal();
   EventSetTimer(1);
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   SaveCursors();
   if(CheckPointer(g_doc) == POINTER_DYNAMIC) delete g_doc;
   Comment("");
  }

void OnTimer()
  {
   datetime now = TimeLocal();
   TrackEquity();
   if(now - g_lastHeartbeat >= InpHeartbeatSec) { Heartbeat(); g_lastHeartbeat = now; }
   SendAcks();
   Pull();
   SendAcks();
   ShowStatus();
  }

//+------------------------------------------------------------------+
//| Server calls                                                      |
//+------------------------------------------------------------------+
void Heartbeat()
  {
   string resp;
   int code = g_api.Post("/ct-heartbeat", QTHeartbeatBody(g_status), 8000, resp);
   if(code == 426) Alert("QT Receiver: cần cập nhật EA. ", g_api.lastError);
   if(code != 200) g_status = "Heartbeat lỗi: " + g_api.lastError;
  }

void Pull()
  {
   string cursors = "";
   for(int i = 0; i < ArraySize(g_curMaster); i++)
      cursors += (i ? "," : "") + JStr(g_curMaster[i]) + ":" + JInt(g_curSeq[i]);
   int wait = MathMax(0, MathMin(20, InpPollWaitSec));
   string resp;
   int code = g_api.Post("/ct-pull", "{\"cursors\":{" + cursors + "},\"wait_s\":" + IntegerToString(wait) + "}", (wait + 10) * 1000, resp);
   if(code != 200) { g_status = "Không lấy được lệnh: " + g_api.lastError; return; }

   CQJ *doc = new CQJ();
   if(!doc.Parse(resp)) { delete doc; g_status = "Phản hồi không hợp lệ"; return; }
   if(CheckPointer(g_doc) == POINTER_DYNAMIC) delete g_doc;
   g_doc = doc;
   g_links = doc.Get("links");
   g_lastPullOk = TimeLocal();
   if(StringFind(g_status, "Không lấy") == 0 || StringFind(g_status, "Phản hồi") == 0) g_status = "";

   // cursors the server resolved (a new master starts at its current seq)
   CQJ *cur = doc.Get("cursors");
   if(cur != NULL)
      for(int i = 0; i < cur.Size(); i++) SetCursor(cur.At(i).key, (long)cur.At(i).n, false);

   CQJ *events = doc.Get("events");
   if(events == NULL) return;
   for(int i = 0; i < events.Size(); i++)
     {
      CQJ *ev = events.At(i);
      string master = ev.Str("master_id");
      long seq = ev.Long("seq");
      CQJ *link = FindLink(master);
      if(link != NULL) Apply(master, seq, ev.Get("payload"), ev.Str("skip_reason"), link);
      SetCursor(master, seq, true);
     }
   SaveCursors();
  }

void SendAcks()
  {
   while(ArraySize(g_acks) > 0)
     {
      int k = MathMin(100, ArraySize(g_acks));
      string body = "{\"results\":[";
      for(int i = 0; i < k; i++) body += (i ? "," : "") + g_acks[i];
      body += "]}";
      string resp;
      int code = g_api.Post("/ct-ack", body, 8000, resp);
      if(code == 200 || code == 400) { if(code == 400) Print("QT Receiver: ack bị từ chối: ", resp); ArrayRemove(g_acks, 0, k); continue; }
      return; // retry next timer tick
     }
  }

CQJ *FindLink(const string master)
  {
   if(g_links == NULL) return NULL;
   for(int i = 0; i < g_links.Size(); i++) if(g_links.At(i).Str("master_id") == master) return g_links.At(i);
   return NULL;
  }

//+------------------------------------------------------------------+
//| Results                                                           |
//+------------------------------------------------------------------+
struct QTResult
  {
   string            status;        // executed | rejected | failed | reconciliation_required
   string            action;
   long              masterTicket;
   string            symbol;
   string            side;
   double            masterVolume;
   double            requested;
   double            volume;
   ulong             receiverTicket;
   double            fillPrice;
   double            slippage;
   string            errorClass;
   int               errorCode;
   string            reason;
   string            riskAction;
  };

void ResetResult(QTResult &r, const string action, long ticket)
  {
   r.status = ""; r.action = action; r.masterTicket = ticket; r.symbol = ""; r.side = "";
   r.masterVolume = 0; r.requested = 0; r.volume = 0; r.receiverTicket = 0; r.fillPrice = 0; r.slippage = 0;
   r.errorClass = ""; r.errorCode = 0; r.reason = ""; r.riskAction = "";
  }

void Ack(const string master, long seq, const QTResult &r, long tsMs)
  {
   string a = "{" + JKs("master_id", master) + "," + JKi("seq", seq) + "," + JKs("status", r.status) + "," + JKs("action", r.action);
   if(r.masterTicket > 0) a += "," + JKi("master_ticket", r.masterTicket);
   if(r.symbol != "") a += "," + JKs("symbol", r.symbol);
   if(r.side != "") a += "," + JKs("side", r.side);
   if(r.masterVolume > 0) a += "," + JKn("master_volume", r.masterVolume);
   if(r.requested > 0) a += "," + JKn("requested_volume", r.requested);
   if(r.volume > 0) a += "," + JKn("volume", r.volume);
   if(r.receiverTicket > 0) a += "," + JKi("receiver_ticket", (long)r.receiverTicket);
   if(r.fillPrice > 0) a += "," + JKn("fill_price", r.fillPrice) + "," + JKn("slippage_points", r.slippage);
   if(r.errorClass != "") a += "," + JKs("error_class", r.errorClass);
   if(r.errorCode != 0) a += "," + JKi("error_code", r.errorCode);
   if(r.reason != "") a += "," + JKs("reason", r.reason);
   if(r.riskAction != "") a += "," + JKs("risk_action", r.riskAction);
   if(tsMs > 0) a += "," + JKi("latency_ms", MathMax(0, QTNowMs() - tsMs));
   a += "}";
   int n = ArraySize(g_acks);
   ArrayResize(g_acks, n + 1);
   g_acks[n] = a;
   if(r.status == "executed") g_done++;
   if(r.status == "failed") g_failed++;
  }

void Reject(QTResult &r, const string cls, const string reason) { r.status = "rejected"; r.errorClass = cls; r.reason = reason; }

string RetcodeClass(uint rc)
  {
   switch(rc)
     {
      case TRADE_RETCODE_MARKET_CLOSED: return "market_closed";
      case TRADE_RETCODE_NO_MONEY: return "insufficient_margin";
      case TRADE_RETCODE_INVALID_VOLUME: return "invalid_volume";
      case TRADE_RETCODE_REQUOTE:
      case TRADE_RETCODE_PRICE_OFF:
      case TRADE_RETCODE_PRICE_CHANGED: return "slippage_exceeded";
      case TRADE_RETCODE_TRADE_DISABLED:
      case TRADE_RETCODE_CLIENT_DISABLES_AT:
      case TRADE_RETCODE_SERVER_DISABLES_AT: return "trade_disabled";
      case TRADE_RETCODE_CONNECTION:
      case TRADE_RETCODE_TIMEOUT: return "mt5_disconnected";
     }
   return "broker_rejected";
  }

bool Ok(uint rc) { return rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_DONE_PARTIAL || rc == TRADE_RETCODE_PLACED; }

//+------------------------------------------------------------------+
//| Tags                                                              |
//+------------------------------------------------------------------+
long MagicFor(const string master)
  {
   long v = 0;
   for(int i = 0; i < 7 && i < StringLen(master); i++)
     {
      ushort c = StringGetCharacter(master, i);
      int d = (c >= '0' && c <= '9') ? c - '0' : (c >= 'a' && c <= 'f') ? c - 'a' + 10 : 0;
      v = v * 16 + d;
     }
   return 700000000 + v % 100000000;
  }

string Tag(long masterTicket) { return "QT#" + JInt(masterTicket); }

//--- master ticket from a "QT#123..." comment, or -1
long TicketFromComment(const string c)
  {
   if(StringFind(c, "QT#") != 0) return -1;
   string digits = "";
   for(int i = 3; i < StringLen(c); i++)
     {
      ushort ch = StringGetCharacter(c, i);
      if(ch < '0' || ch > '9') break;
      digits += ShortToString(ch);
     }
   return digits == "" ? -1 : StringToInteger(digits);
  }

//--- positions of this master copy with that master ticket
int TaggedPositions(long magic, long masterTicket, ulong &tickets[])
  {
   ArrayResize(tickets, 0);
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0 || PositionGetInteger(POSITION_MAGIC) != magic) continue;
      if(masterTicket >= 0 && TicketFromComment(PositionGetString(POSITION_COMMENT)) != masterTicket) continue;
      int n = ArraySize(tickets);
      ArrayResize(tickets, n + 1);
      tickets[n] = tk;
     }
   return ArraySize(tickets);
  }

ulong TaggedOrder(long magic, long masterTicket)
  {
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong tk = OrderGetTicket(i);
      if(tk != 0 && OrderGetInteger(ORDER_MAGIC) == magic && TicketFromComment(OrderGetString(ORDER_COMMENT)) == masterTicket) return tk;
     }
   return 0;
  }

bool InList(string &list[], const string key) { for(int i = 0; i < ArraySize(list); i++) if(list[i] == key) return true; return false; }
void AddToList(string &list[], const string key) { if(InList(list, key)) return; int n = ArraySize(list); ArrayResize(list, n + 1); list[n] = key; }

//+------------------------------------------------------------------+
//| Applying one master event                                         |
//+------------------------------------------------------------------+
void Apply(const string master, long seq, CQJ *e, const string skipReason, CQJ *link)
  {
   if(e == NULL) return;
   string type = e.Str("type");
   long ticket = e.Long("master_ticket");
   long tsMs = e.Long("ts_ms");
   CQJ *s = link.Get("settings");
   long magic = MagicFor(master);
   QTResult r;
   ResetResult(r, type, ticket);
   r.symbol = e.Str("symbol");
   r.side = e.Str("side");
   r.masterVolume = e.Num("volume");

   if(skipReason != "")
     {
      if(type == "SNAPSHOT") return;                       // nothing to report
      if(type == "OPEN" || type == "PENDING_PLACE") AddToList(g_skipped, master + ":" + JInt(ticket));
      Reject(r, StringFind(skipReason, "group_") == 0 ? "group_paused" : "filtered", skipReason);
      Ack(master, seq, r, tsMs);
      return;
     }
   if(type == "SNAPSHOT") { Reconcile(master, seq, e, s, magic); return; }
   if(type == "KILL") { CloseAll(master, seq, magic, tsMs); return; }

   string filter = QTFilterReason(e, s, link.Get("group_symbols"));
   if(filter != "")
     {
      if(type == "OPEN" || type == "PENDING_PLACE") AddToList(g_skipped, master + ":" + JInt(ticket));
      Reject(r, "filtered", filter);
      Ack(master, seq, r, tsMs);
      return;
     }
   if(QTIsStale(type, tsMs, QTNowMs(), (int)s.Num("max_signal_age_s", 10)))
     {
      AddToList(g_skipped, master + ":" + JInt(ticket));
      Reject(r, "stale_signal", StringFormat("tín hiệu cũ %d s", (int)((QTNowMs() - tsMs) / 1000)));
      Ack(master, seq, r, tsMs);
      return;
     }

   if(type == "OPEN") DoOpen(master, seq, e, s, magic, r, tsMs);
   else if(type == "CLOSE") DoClose(master, seq, ticket, magic, r, tsMs);
   else if(type == "PARTIAL_CLOSE") DoPartial(master, seq, e, magic, r, tsMs);
   else if(type == "MODIFY") DoModify(master, seq, e, s, magic, r, tsMs);
   else if(type == "PENDING_PLACE") DoPendingPlace(master, seq, e, s, magic, r, tsMs);
   else if(type == "PENDING_MODIFY" || type == "PENDING_DELETE") DoPendingChange(master, seq, e, magic, r, tsMs);
  }

//--- lot for an OPEN / PENDING_PLACE on receiver symbol `sym`
double LotFor(CQJ *e, CQJ *s, const string sym, string &skip)
  {
   QTLotArgs a;
   a.mode = s.Str("lot_mode", "equity_ratio");
   a.value = s.Num("lot_value", 1);
   a.masterLot = e.Num("volume");
   a.masterBalance = e.Num("master_balance");
   a.masterEquity = e.Num("master_equity");
   a.receiverBalance = AccountInfoDouble(ACCOUNT_BALANCE);
   a.receiverEquity = AccountInfoDouble(ACCOUNT_EQUITY);
   a.masterContractSize = e.Num("contract_size");
   a.receiverContractSize = SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE);
   a.slDistance = e.Has("sl") ? MathAbs(e.Num("price") - e.Num("sl")) : 0;
   a.tickSize = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   a.tickValue = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
   a.volMin = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   a.volMax = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   a.volStep = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   a.maxLot = s.Num("max_lot", 0);
   a.minLot = s.Num("min_lot", 0);
   a.belowMin = s.Str("below_min", "skip");
   return QTComputeLot(a, skip);
  }

//--- risk context for this receiver and master
void RiskCtx(QTRiskCtx &c, long magic, const string sym, ENUM_ORDER_TYPE ot, double lot, double price)
  {
   c.online = TerminalInfoInteger(TERMINAL_CONNECTED) != 0;
   c.tradeAllowed = TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) != 0 && MQLInfoInteger(MQL_TRADE_ALLOWED) != 0 && AccountInfoInteger(ACCOUNT_TRADE_EXPERT) != 0;
   c.lot = lot;
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   c.spreadPoints = point > 0 ? (SymbolInfoDouble(sym, SYMBOL_ASK) - SymbolInfoDouble(sym, SYMBOL_BID)) / point : 0;
   ulong tickets[];
   c.openPositions = TaggedPositions(magic, -1, tickets);
   c.openLots = 0;
   for(int i = 0; i < ArraySize(tickets); i++) if(PositionSelectByTicket(tickets[i])) c.openLots += PositionGetDouble(POSITION_VOLUME);
   c.equity = AccountInfoDouble(ACCOUNT_EQUITY);
   c.dayStartEquity = GlobalVariableGet(DayKey());
   c.peakEquity = GlobalVariableGet(PeakKey());
   double m = 0;
   if(!OrderCalcMargin(ot, sym, lot, price, m)) m = 0;
   c.marginAfter = AccountInfoDouble(ACCOUNT_MARGIN) + m;
   c.freeMarginAfter = AccountInfoDouble(ACCOUNT_MARGIN_FREE) - m;
  }

//--- returns false (and fills r) when a risk limit blocks the trade
bool PassesRisk(CQJ *s, long magic, const string sym, ENUM_ORDER_TYPE ot, double lot, double price, QTResult &r)
  {
   QTRiskCtx c;
   RiskCtx(c, magic, sym, ot, lot, price);
   string action;
   string rule = QTRiskCheck(s, c, action);
   if(rule == "") return true;
   if(action == "alert")
     {
      r.errorClass = "risk_limit"; r.riskAction = "alert"; r.reason = "ALERT " + rule;
      return true;                                          // operator chose to trade anyway
     }
   if(action == "manual_approval") { action = "reject"; rule += " (cần duyệt thủ công: chưa hỗ trợ, đã từ chối)"; }
   Reject(r, rule == "INSUFFICIENT_MARGIN" ? "insufficient_margin" : "risk_limit", rule);
   r.riskAction = action;
   return false;
  }

void DoOpen(const string master, long seq, CQJ *e, CQJ *s, long magic, QTResult &r, long tsMs)
  {
   long ticket = e.Long("master_ticket");
   ulong existing[];
   if(TaggedPositions(magic, ticket, existing) > 0) return;   // already copied (restart, resent event)

   string sym = QTMapSymbol(e.Str("symbol"), s.Get("symbol_map"));
   if(sym == "") { AddToList(g_skipped, master + ":" + JInt(ticket)); Reject(r, "symbol_not_found", "không có " + e.Str("symbol")); Ack(master, seq, r, tsMs); return; }
   SymbolSelect(sym, true);
   r.symbol = sym;

   bool buy = e.Str("side") == "BUY";
   if(s.Bool("reverse")) buy = !buy;
   r.side = buy ? "BUY" : "SELL";

   string skip;
   double lot = LotFor(e, s, sym, skip);
   if(lot <= 0) { AddToList(g_skipped, master + ":" + JInt(ticket)); Reject(r, "invalid_volume", skip); Ack(master, seq, r, tsMs); return; }
   r.requested = lot;

   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   double price = buy ? SymbolInfoDouble(sym, SYMBOL_ASK) : SymbolInfoDouble(sym, SYMBOL_BID);
   int maxSlip = (int)s.Num("max_slippage_points", 50);
   double masterPrice = e.Num("price");
   if(point > 0 && masterPrice > 0)
     {
      // adverse move since the master filled, in receiver points (brokers may quote slightly differently)
      double adverse = (buy ? price - masterPrice : masterPrice - price) / point;
      if(adverse > maxSlip)
        {
         AddToList(g_skipped, master + ":" + JInt(ticket));
         Reject(r, "slippage_exceeded", StringFormat("giá đã chạy %.0f points (giới hạn %d)", adverse, maxSlip));
         Ack(master, seq, r, tsMs);
         return;
        }
     }
   if(!PassesRisk(s, magic, sym, buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL, lot, price, r))
     {
      AddToList(g_skipped, master + ":" + JInt(ticket));
      Ack(master, seq, r, tsMs);
      return;
     }

   double sl = 0, tp = 0;
   if(s.Bool("copy_sl_tp", true) && !s.Bool("reverse")) { sl = e.Num("sl"); tp = e.Num("tp"); }
   g_trade.SetExpertMagicNumber(magic);
   g_trade.SetDeviationInPoints(maxSlip);
   g_trade.SetTypeFillingBySymbol(sym);
   bool sent = buy ? g_trade.Buy(lot, sym, 0, sl, tp, Tag(ticket)) : g_trade.Sell(lot, sym, 0, sl, tp, Tag(ticket));
   uint rc = g_trade.ResultRetcode();
   if(sent && Ok(rc))
     {
      r.status = "executed";
      r.volume = g_trade.ResultVolume();
      r.receiverTicket = g_trade.ResultOrder();
      r.fillPrice = g_trade.ResultPrice();
      if(point > 0 && masterPrice > 0) r.slippage = MathAbs(r.fillPrice - masterPrice) / point;
     }
   else
     {
      // never retry an open blindly: check whether the broker took it before reporting a failure
      ulong check[];
      if(TaggedPositions(magic, ticket, check) > 0)
        {
         r.status = "executed";
         r.receiverTicket = check[0];
         if(PositionSelectByTicket(check[0])) { r.volume = PositionGetDouble(POSITION_VOLUME); r.fillPrice = PositionGetDouble(POSITION_PRICE_OPEN); }
        }
      else
        {
         r.status = "failed";
         r.errorCode = (int)rc;
         r.errorClass = RetcodeClass(rc);
         r.reason = g_trade.ResultRetcodeDescription();
        }
     }
   Ack(master, seq, r, tsMs);
  }

void DoClose(const string master, long seq, long ticket, long magic, QTResult &r, long tsMs)
  {
   ulong ord = TaggedOrder(magic, ticket);
   if(ord > 0) g_trade.OrderDelete(ord);
   ulong tickets[];
   if(TaggedPositions(magic, ticket, tickets) == 0)
     {
      if(InList(g_skipped, master + ":" + JInt(ticket))) return;     // we never opened it: nothing to report
      Reject(r, "other", "không có vị thế QT#" + JInt(ticket) + " trên receiver");
      Ack(master, seq, r, tsMs);
      return;
     }
   for(int i = 0; i < ArraySize(tickets); i++)
     {
      if(PositionSelectByTicket(tickets[i])) { r.symbol = PositionGetString(POSITION_SYMBOL); r.volume = PositionGetDouble(POSITION_VOLUME); }
      g_trade.SetExpertMagicNumber(magic);
      if(g_trade.PositionClose(tickets[i]) && Ok(g_trade.ResultRetcode()))
        {
         r.status = "executed"; r.receiverTicket = tickets[i]; r.fillPrice = g_trade.ResultPrice();
        }
      else
        {
         r.status = "failed"; r.errorCode = (int)g_trade.ResultRetcode(); r.errorClass = RetcodeClass(g_trade.ResultRetcode());
         r.reason = g_trade.ResultRetcodeDescription();
        }
     }
   Ack(master, seq, r, tsMs);
  }

void DoPartial(const string master, long seq, CQJ *e, long magic, QTResult &r, long tsMs)
  {
   long ticket = e.Long("master_ticket");
   ulong tickets[];
   if(TaggedPositions(magic, ticket, tickets) == 0) { if(!InList(g_skipped, master + ":" + JInt(ticket))) { Reject(r, "other", "không có vị thế để đóng một phần"); Ack(master, seq, r, tsMs); } return; }
   if(!PositionSelectByTicket(tickets[0])) return;
   string sym = PositionGetString(POSITION_SYMBOL);
   double have = PositionGetDouble(POSITION_VOLUME);
   double v = QTPartialCloseVolume(e.Num("volume"), e.Num("volume_before"), have, SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP), SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN));
   r.symbol = sym;
   r.requested = v;
   if(v <= 0) { Reject(r, "invalid_volume", "phần đóng nhỏ hơn lot tối thiểu"); Ack(master, seq, r, tsMs); return; }
   g_trade.SetExpertMagicNumber(magic);
   bool ok = v >= have - 1e-9 ? g_trade.PositionClose(tickets[0]) : g_trade.PositionClosePartial(tickets[0], v);
   if(ok && Ok(g_trade.ResultRetcode())) { r.status = "executed"; r.volume = v; r.receiverTicket = tickets[0]; r.fillPrice = g_trade.ResultPrice(); }
   else { r.status = "failed"; r.errorCode = (int)g_trade.ResultRetcode(); r.errorClass = RetcodeClass(g_trade.ResultRetcode()); r.reason = g_trade.ResultRetcodeDescription(); }
   Ack(master, seq, r, tsMs);
  }

void DoModify(const string master, long seq, CQJ *e, CQJ *s, long magic, QTResult &r, long tsMs)
  {
   if(s.Bool("reverse")) return;                            // mirrored SL/TP are not meaningful
   long ticket = e.Long("master_ticket");
   ulong tickets[];
   if(TaggedPositions(magic, ticket, tickets) == 0) return;
   double sl = e.Num("sl"), tp = e.Num("tp");
   bool ok = true;
   for(int i = 0; i < ArraySize(tickets); i++)
     {
      if(!PositionSelectByTicket(tickets[i])) continue;
      if(MathAbs(PositionGetDouble(POSITION_SL) - sl) < 1e-9 && MathAbs(PositionGetDouble(POSITION_TP) - tp) < 1e-9) continue;
      r.symbol = PositionGetString(POSITION_SYMBOL);
      ok = g_trade.PositionModify(tickets[i], sl, tp) && Ok(g_trade.ResultRetcode()) && ok;
     }
   if(ok) r.status = "executed";
   else { r.status = "failed"; r.errorCode = (int)g_trade.ResultRetcode(); r.errorClass = RetcodeClass(g_trade.ResultRetcode()); r.reason = g_trade.ResultRetcodeDescription(); }
   Ack(master, seq, r, tsMs);
  }

ENUM_ORDER_TYPE PendingType(const string side, bool reverse)
  {
   string sd = side;
   if(reverse)
     {
      if(sd == "BUY_LIMIT") sd = "SELL_STOP"; else if(sd == "SELL_LIMIT") sd = "BUY_STOP";
      else if(sd == "BUY_STOP") sd = "SELL_LIMIT"; else if(sd == "SELL_STOP") sd = "BUY_LIMIT";
     }
   if(sd == "BUY_LIMIT") return ORDER_TYPE_BUY_LIMIT;
   if(sd == "SELL_LIMIT") return ORDER_TYPE_SELL_LIMIT;
   if(sd == "BUY_STOP") return ORDER_TYPE_BUY_STOP;
   return ORDER_TYPE_SELL_STOP;
  }

void DoPendingPlace(const string master, long seq, CQJ *e, CQJ *s, long magic, QTResult &r, long tsMs)
  {
   long ticket = e.Long("master_ticket");
   if(TaggedOrder(magic, ticket) > 0) return;
   string sym = QTMapSymbol(e.Str("symbol"), s.Get("symbol_map"));
   if(sym == "") { Reject(r, "symbol_not_found", "không có " + e.Str("symbol")); Ack(master, seq, r, tsMs); return; }
   SymbolSelect(sym, true);
   r.symbol = sym;
   string skip;
   double lot = LotFor(e, s, sym, skip);
   if(lot <= 0) { Reject(r, "invalid_volume", skip); Ack(master, seq, r, tsMs); return; }
   ENUM_ORDER_TYPE ot = PendingType(e.Str("side"), s.Bool("reverse"));
   if(!PassesRisk(s, magic, sym, ot, lot, e.Num("price"), r)) { Ack(master, seq, r, tsMs); return; }
   double sl = 0, tp = 0;
   if(s.Bool("copy_sl_tp", true) && !s.Bool("reverse")) { sl = e.Num("sl"); tp = e.Num("tp"); }
   g_trade.SetExpertMagicNumber(magic);
   g_trade.SetTypeFillingBySymbol(sym);
   if(g_trade.OrderOpen(sym, ot, lot, 0, e.Num("price"), sl, tp, ORDER_TIME_GTC, 0, Tag(ticket)) && Ok(g_trade.ResultRetcode()))
     { r.status = "executed"; r.requested = lot; r.volume = lot; r.receiverTicket = g_trade.ResultOrder(); }
   else { r.status = "failed"; r.errorCode = (int)g_trade.ResultRetcode(); r.errorClass = RetcodeClass(g_trade.ResultRetcode()); r.reason = g_trade.ResultRetcodeDescription(); }
   Ack(master, seq, r, tsMs);
  }

void DoPendingChange(const string master, long seq, CQJ *e, long magic, QTResult &r, long tsMs)
  {
   ulong ord = TaggedOrder(magic, e.Long("master_ticket"));
   if(ord == 0) return;
   bool ok;
   if(e.Str("type") == "PENDING_DELETE") ok = g_trade.OrderDelete(ord);
   else
     {
      if(!OrderSelect(ord)) return;
      ok = g_trade.OrderModify(ord, e.Num("price", OrderGetDouble(ORDER_PRICE_OPEN)), e.Num("sl"), e.Num("tp"), ORDER_TIME_GTC, 0);
     }
   if(ok && Ok(g_trade.ResultRetcode())) r.status = "executed";
   else { r.status = "failed"; r.errorCode = (int)g_trade.ResultRetcode(); r.errorClass = RetcodeClass(g_trade.ResultRetcode()); r.reason = g_trade.ResultRetcodeDescription(); }
   Ack(master, seq, r, tsMs);
  }

//--- KILL (Close All): close every position and order of this master's copies
void CloseAll(const string master, long seq, long magic, long tsMs)
  {
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong tk = OrderGetTicket(i);
      if(tk != 0 && OrderGetInteger(ORDER_MAGIC) == magic) g_trade.OrderDelete(tk);
     }
   ulong tickets[];
   TaggedPositions(magic, -1, tickets);
   for(int i = 0; i < ArraySize(tickets); i++)
     {
      if(!PositionSelectByTicket(tickets[i])) continue;
      QTResult r;
      ResetResult(r, "KILL", TicketFromComment(PositionGetString(POSITION_COMMENT)));
      r.symbol = PositionGetString(POSITION_SYMBOL);
      r.volume = PositionGetDouble(POSITION_VOLUME);
      g_trade.SetExpertMagicNumber(magic);
      if(g_trade.PositionClose(tickets[i]) && Ok(g_trade.ResultRetcode())) { r.status = "executed"; r.receiverTicket = tickets[i]; r.fillPrice = g_trade.ResultPrice(); }
      else { r.status = "failed"; r.errorCode = (int)g_trade.ResultRetcode(); r.errorClass = RetcodeClass(g_trade.ResultRetcode()); r.reason = g_trade.ResultRetcodeDescription(); }
      Ack(master, seq, r, tsMs);
     }
  }

//--- SNAPSHOT: close orphans (master closed, receiver still open), report missing copies once
void Reconcile(const string master, long seq, CQJ *e, CQJ *s, long magic)
  {
   long tsMs = e.Long("ts_ms");
   if(QTNowMs() - tsMs > (long)InpSnapshotMaxAgeSec * 1000) return;    // too old to trust
   CQJ *pos = e.Get("positions");
   if(pos == NULL) return;
   ulong tickets[];
   TaggedPositions(magic, -1, tickets);
   for(int i = 0; i < ArraySize(tickets); i++)
     {
      if(!PositionSelectByTicket(tickets[i])) continue;
      long mt = TicketFromComment(PositionGetString(POSITION_COMMENT));
      bool open = false;
      for(int k = 0; k < pos.Size(); k++) if(pos.At(k).Long("master_ticket") == mt) { open = true; break; }
      if(open || mt < 0) continue;
      QTResult r;
      ResetResult(r, "RECONCILE_CLOSE", mt);
      r.symbol = PositionGetString(POSITION_SYMBOL);
      r.volume = PositionGetDouble(POSITION_VOLUME);
      if(!s.Bool("copy_close", true))
        {
         string key = master + ":" + JInt(mt) + ":orphan";
         if(InList(g_reported, key)) continue;
         AddToList(g_reported, key);
         r.status = "reconciliation_required"; r.reason = "Master đã đóng, receiver còn mở (không tự đóng vì tắt copy đóng lệnh)";
        }
      else
        {
         g_trade.SetExpertMagicNumber(magic);
         if(g_trade.PositionClose(tickets[i]) && Ok(g_trade.ResultRetcode())) { r.status = "executed"; r.receiverTicket = tickets[i]; r.reason = "đóng vị thế mồ côi theo đối soát"; }
         else { r.status = "failed"; r.errorCode = (int)g_trade.ResultRetcode(); r.errorClass = RetcodeClass(g_trade.ResultRetcode()); r.reason = g_trade.ResultRetcodeDescription(); }
        }
      Ack(master, seq, r, 0);
     }
   // master positions with no copy here (and not skipped on purpose): report once, never open late
   for(int k = 0; k < pos.Size(); k++)
     {
      long mt = pos.At(k).Long("master_ticket");
      string key = master + ":" + JInt(mt);
      ulong found[];
      if(TaggedPositions(magic, mt, found) > 0 || InList(g_skipped, key) || InList(g_reported, key)) continue;
      AddToList(g_reported, key);
      QTResult r;
      ResetResult(r, "RECONCILE", mt);
      r.symbol = pos.At(k).Str("symbol");
      r.side = pos.At(k).Str("side");
      r.masterVolume = pos.At(k).Num("volume");
      r.status = "reconciliation_required";
      r.reason = "Master đang mở vị thế này nhưng receiver không có bản copy";
      Ack(master, seq, r, 0);
     }
  }

//+------------------------------------------------------------------+
//| Cursors, equity tracking, status                                  |
//+------------------------------------------------------------------+
string CursorFile(void) { return StringFormat("QT_recv_%I64d.cur", g_login); }

void SetCursor(const string master, long seq, bool onlyForward)
  {
   for(int i = 0; i < ArraySize(g_curMaster); i++)
      if(g_curMaster[i] == master)
        {
         if(!onlyForward || seq > g_curSeq[i]) g_curSeq[i] = seq;
         return;
        }
   int n = ArraySize(g_curMaster);
   ArrayResize(g_curMaster, n + 1);
   ArrayResize(g_curSeq, n + 1);
   g_curMaster[n] = master;
   g_curSeq[n] = seq;
  }

void SaveCursors()
  {
   int h = FileOpen(CursorFile(), FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   for(int i = 0; i < ArraySize(g_curMaster); i++) FileWriteString(h, g_curMaster[i] + "=" + JInt(g_curSeq[i]) + "\n");
   FileClose(h);
  }

void LoadCursors()
  {
   if(!FileIsExist(CursorFile())) return;
   int h = FileOpen(CursorFile(), FILE_READ | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   while(!FileIsEnding(h))
     {
      string kv[];
      if(StringSplit(FileReadString(h), '=', kv) == 2) SetCursor(kv[0], StringToInteger(kv[1]), false);
     }
   FileClose(h);
  }

string DayKey(void) { MqlDateTime t; TimeToStruct(TimeTradeServer(), t); return StringFormat("QT_%I64d_dse_%04d%02d%02d", g_login, t.year, t.mon, t.day); }
string PeakKey(void) { return StringFormat("QT_%I64d_peak", g_login); }

void TrackEquity()
  {
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   if(!GlobalVariableCheck(DayKey())) GlobalVariableSet(DayKey(), eq);
   if(eq > GlobalVariableGet(PeakKey())) GlobalVariableSet(PeakKey(), eq);
  }

void ShowStatus()
  {
   string links = "";
   if(g_links != NULL)
      for(int i = 0; i < g_links.Size(); i++)
        {
         CQJ *l = g_links.At(i);
         links += StringFormat("\n  master %s…  group: %s  copy: %s", StringSubstr(l.Str("master_id"), 0, 8), l.Str("group_state"), l.Bool("enabled") ? "bật" : "tắt");
        }
   Comment(StringFormat("QT Receiver %s\nLần lấy lệnh gần nhất: %s\nĐã thực hiện: %d · lỗi: %d · chờ báo: %d%s\n%s",
                        QT_EA_VERSION, g_lastPullOk > 0 ? TimeToString(g_lastPullOk, TIME_SECONDS) : "chưa", g_done, g_failed,
                        ArraySize(g_acks), links == "" ? "\n  (chưa được thêm vào group nào)" : links, g_status));
  }
//+------------------------------------------------------------------+
