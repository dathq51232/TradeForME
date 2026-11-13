//+------------------------------------------------------------------+
//| QT_MasterSender.mq5 — sends this account's trades to Quant        |
//| Terminal Cloud, which fans them out to the linked receivers.      |
//|                                                                  |
//| Setup: attach to ONE chart of the master terminal. Allow          |
//| WebRequest for the API URL (Tools > Options > Expert Advisors).   |
//| Token and secret come from the dashboard (Tài khoản MT5).         |
//+------------------------------------------------------------------+
#property copyright "Quant Terminal Cloud (MIT)"
#property version   "1.00"
#property strict

#include <QT\Api.mqh>
#include <QT\SelfTest.mqh>

input string InpConnection   = "";      // Mã kết nối (dán từ trang Tài khoản MT5)
input string InpBarSymbols    = "XAUUSD=XAUUSD,XAGUSD=XAGUSD,WTI=USOIL,BRENT=UKOIL"; // chart symbol=this broker's symbol; empty = do not send prices
input int    InpSnapshotSec   = 30;      // position snapshot for reconciliation (s)
input int    InpHeartbeatSec  = 30;      // heartbeat (s)
input long   InpMagicFilter   = -1;      // copy only positions with this magic (-1 = all)
input group "Nâng cao (để trống nếu đã có mã kết nối)"
input string InpApiUrl       = "";      // API URL
input string InpToken        = "";      // EA token
input string InpSecret       = "";      // HMAC secret

CQTApi   g_api;
string   g_queue[];                      // pending event JSON objects, oldest first
datetime g_lastSnapshot = 0, g_lastHeartbeat = 0, g_lastBars = 0;
long     g_login;
string   g_status = "";
int      g_sent = 0;
string   g_barMap[][2];                  // [chart symbol, broker symbol]
bool     g_barsBackfilled = false;

string QueueFile(void) { return StringFormat("QT_master_queue_%I64d.txt", g_login); }

//+------------------------------------------------------------------+
int OnInit()
  {
   g_login = AccountInfoInteger(ACCOUNT_LOGIN);
   string setupError = QTSetup(g_api, InpConnection, InpApiUrl, InpToken, InpSecret);
   if(setupError != "")
     {
      Alert("QT Master: ", setupError);
      return INIT_PARAMETERS_INCORRECT;
     }
   if(AccountInfoInteger(ACCOUNT_MARGIN_MODE) != ACCOUNT_MARGIN_MODE_RETAIL_HEDGING)
      Print("QT Master: tài khoản không phải Hedging. Thêm khối lượng vào vị thế đang có (netting) sẽ không được copy đúng.");
   ParseBarMap();
   LoadQueue();
   EventSetTimer(1);
   g_qtKind = "master";
   g_qtSelfTest = QTSelfTest(false);   // reported with the heartbeat, shown on the dashboard
   if(QTStartupCheck(g_api, "QT Master")) g_lastHeartbeat = TimeLocal();
   if(g_qtSelfTest != "ok")
     {
      Alert("QT Master: self-test lỗi (", g_qtSelfTest, "). EA dừng để không xử lý lệnh sai.");
      return INIT_FAILED;
     }
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   SaveQueue();
   Comment("");
  }

//+------------------------------------------------------------------+
//| Trade events -> queue                                             |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &t, const MqlTradeRequest &req, const MqlTradeResult &res)
  {
   if(t.type == TRADE_TRANSACTION_DEAL_ADD) OnDeal(t.deal);
   else if(t.type == TRADE_TRANSACTION_POSITION) OnPositionChange(t);
   else if(t.type == TRADE_TRANSACTION_ORDER_ADD || t.type == TRADE_TRANSACTION_ORDER_UPDATE || t.type == TRADE_TRANSACTION_ORDER_DELETE)
      OnPendingOrder(t);
   Flush();
  }

bool MagicOk(long magic) { return InpMagicFilter < 0 || magic == InpMagicFilter; }

string Common(const string uid, const string type)
  {
   return JKs("event_uid", uid) + "," + JKs("type", type) + "," + JKi("ts_ms", QTNowMs());
  }

void OnDeal(ulong deal)
  {
   if(!HistoryDealSelect(deal)) return;
   long entry = HistoryDealGetInteger(deal, DEAL_ENTRY);
   long dtype = HistoryDealGetInteger(deal, DEAL_TYPE);
   if(dtype != DEAL_TYPE_BUY && dtype != DEAL_TYPE_SELL) return;   // balance, commission, ...
   if(!MagicOk(HistoryDealGetInteger(deal, DEAL_MAGIC)) && entry == DEAL_ENTRY_IN) return;
   long pos = HistoryDealGetInteger(deal, DEAL_POSITION_ID);
   string sym = HistoryDealGetString(deal, DEAL_SYMBOL);
   double vol = HistoryDealGetDouble(deal, DEAL_VOLUME);
   double price = HistoryDealGetDouble(deal, DEAL_PRICE);
   string uidBase = StringFormat("%I64d-DEAL-%I64u", g_login, deal);

   if(entry == DEAL_ENTRY_IN)
     {
      string e = "{" + Common(uidBase, "OPEN") + "," + JKi("master_ticket", pos) + "," + JKs("symbol", sym) + ","
                 + JKs("side", dtype == DEAL_TYPE_BUY ? "BUY" : "SELL") + "," + JKn("volume", vol) + "," + JKn("price", price) + ","
                 + JKn("master_balance", AccountInfoDouble(ACCOUNT_BALANCE)) + "," + JKn("master_equity", AccountInfoDouble(ACCOUNT_EQUITY)) + ","
                 + JKn("contract_size", SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE));
      if(PositionSelectByTicket(pos))
        {
         if(PositionGetDouble(POSITION_SL) > 0) e += "," + JKn("sl", PositionGetDouble(POSITION_SL));
         if(PositionGetDouble(POSITION_TP) > 0) e += "," + JKn("tp", PositionGetDouble(POSITION_TP));
        }
      Enqueue(e + "}");
     }
   else if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY)
     {
      if(PositionSelectByTicket(pos))
        {
         double remaining = PositionGetDouble(POSITION_VOLUME);
         Enqueue("{" + Common(uidBase, "PARTIAL_CLOSE") + "," + JKi("master_ticket", pos) + "," + JKs("symbol", sym) + ","
                 + JKn("volume", vol) + "," + JKn("volume_before", remaining + vol) + "," + JKn("price", price) + "}");
        }
      else
         Enqueue("{" + Common(uidBase, "CLOSE") + "," + JKi("master_ticket", pos) + "," + JKs("symbol", sym) + "," + JKn("price", price) + "}");
     }
   else if(entry == DEAL_ENTRY_INOUT)
      Print("QT Master: lệnh đảo chiều (netting) chưa được hỗ trợ, deal ", deal);
  }

//--- SL/TP changes of an open position
void OnPositionChange(const MqlTradeTransaction &t)
  {
   if(!PositionSelectByTicket(t.position)) return;
   if(!MagicOk(PositionGetInteger(POSITION_MAGIC))) return;
   string uid = StringFormat("%I64d-MOD-%I64u-%I64u", g_login, t.position, GetMicrosecondCount());
   string e = "{" + Common(uid, "MODIFY") + "," + JKi("master_ticket", (long)t.position) + "," + JKs("symbol", t.symbol);
   if(t.price_sl > 0) e += "," + JKn("sl", t.price_sl);
   if(t.price_tp > 0) e += "," + JKn("tp", t.price_tp);
   Enqueue(e + "}");
  }

string PendingSide(ENUM_ORDER_TYPE t)
  {
   switch(t)
     {
      case ORDER_TYPE_BUY_LIMIT: return "BUY_LIMIT";
      case ORDER_TYPE_SELL_LIMIT: return "SELL_LIMIT";
      case ORDER_TYPE_BUY_STOP: return "BUY_STOP";
      case ORDER_TYPE_SELL_STOP: return "SELL_STOP";
     }
   return "";
  }

void OnPendingOrder(const MqlTradeTransaction &t)
  {
   string side = PendingSide(t.order_type);
   if(side == "") return;                                  // market orders arrive as deals
   string id = StringFormat("%I64d-ORD-%I64u", g_login, t.order);
   if(t.type == TRADE_TRANSACTION_ORDER_ADD)
     {
      string e = "{" + Common(id + "-ADD", "PENDING_PLACE") + "," + JKi("master_ticket", (long)t.order) + "," + JKs("symbol", t.symbol) + ","
                 + JKs("side", side) + "," + JKn("volume", t.volume) + "," + JKn("price", t.price) + ","
                 + JKn("master_balance", AccountInfoDouble(ACCOUNT_BALANCE)) + "," + JKn("master_equity", AccountInfoDouble(ACCOUNT_EQUITY)) + ","
                 + JKn("contract_size", SymbolInfoDouble(t.symbol, SYMBOL_TRADE_CONTRACT_SIZE));
      if(t.price_sl > 0) e += "," + JKn("sl", t.price_sl);
      if(t.price_tp > 0) e += "," + JKn("tp", t.price_tp);
      Enqueue(e + "}");
     }
   else if(t.type == TRADE_TRANSACTION_ORDER_UPDATE)
     {
      string e = "{" + Common(StringFormat("%s-UPD-%I64u", id, GetMicrosecondCount()), "PENDING_MODIFY") + "," + JKi("master_ticket", (long)t.order) + ","
                 + JKn("price", t.price);
      if(t.price_sl > 0) e += "," + JKn("sl", t.price_sl);
      if(t.price_tp > 0) e += "," + JKn("tp", t.price_tp);
      Enqueue(e + "}");
     }
   else if(t.order_state == ORDER_STATE_CANCELED || t.order_state == ORDER_STATE_EXPIRED || t.order_state == ORDER_STATE_REJECTED)
      // a FILLED pending order becomes a position: its deal sends OPEN with master_ticket = this order ticket
      Enqueue("{" + Common(id + "-DEL", "PENDING_DELETE") + "," + JKi("master_ticket", (long)t.order) + "}");
  }

//+------------------------------------------------------------------+
//| Timer: retry queue, snapshot, heartbeat, broker bars              |
//+------------------------------------------------------------------+
void OnTimer()
  {
   datetime now = TimeLocal();
   Flush();
   if(now - g_lastSnapshot >= InpSnapshotSec) { Snapshot(); g_lastSnapshot = now; Flush(); }
   if(now - g_lastHeartbeat >= InpHeartbeatSec) { Heartbeat(); g_lastHeartbeat = now; }
   if(ArrayRange(g_barMap, 0) > 0 && now - g_lastBars >= 60) { PushBars(); g_lastBars = now; }
   Comment(StringFormat("QT Master %s\nĐã gửi: %d sự kiện · hàng đợi: %d\n%s", QT_EA_VERSION, g_sent, ArraySize(g_queue), g_status));
  }

void Snapshot()
  {
   string list = "";
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0 || !MagicOk(PositionGetInteger(POSITION_MAGIC))) continue;
      string p = "{" + JKi("master_ticket", (long)tk) + "," + JKs("symbol", PositionGetString(POSITION_SYMBOL)) + ","
                 + JKs("side", PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "BUY" : "SELL") + ","
                 + JKn("volume", PositionGetDouble(POSITION_VOLUME)) + "," + JKn("price", PositionGetDouble(POSITION_PRICE_OPEN));
      if(PositionGetDouble(POSITION_SL) > 0) p += "," + JKn("sl", PositionGetDouble(POSITION_SL));
      if(PositionGetDouble(POSITION_TP) > 0) p += "," + JKn("tp", PositionGetDouble(POSITION_TP));
      list += (list == "" ? "" : ",") + p + "}";
     }
   Enqueue("{" + Common(StringFormat("%I64d-SNAP-%I64d", g_login, QTNowMs()), "SNAPSHOT") + ",\"positions\":[" + list + "]}");
  }

void Heartbeat()
  {
   string resp;
   int code = g_api.Post("/ct-heartbeat", QTHeartbeatBody(g_status == "" ? "" : g_status), 8000, resp);
   if(code == 426) Alert("QT Master: cần cập nhật EA. ", g_api.lastError);
   if(code != 200) g_status = "Heartbeat lỗi: " + g_api.lastError;
   else if(StringFind(g_status, "Heartbeat") == 0) g_status = "";
  }

//+------------------------------------------------------------------+
//| Queue                                                             |
//+------------------------------------------------------------------+
void Enqueue(const string e)
  {
   int n = ArraySize(g_queue);
   if(n >= 5000) { Print("QT Master: hàng đợi đầy, bỏ sự kiện cũ nhất"); ArrayRemove(g_queue, 0, 1); n--; }
   ArrayResize(g_queue, n + 1);
   g_queue[n] = e;
  }

void Flush()
  {
   while(ArraySize(g_queue) > 0)
     {
      int k = MathMin(50, ArraySize(g_queue));
      string body = "{\"events\":[";
      for(int i = 0; i < k; i++) body += (i ? "," : "") + g_queue[i];
      body += "]}";
      string resp;
      int code = g_api.Post("/ct-ingest", body, 8000, resp);
      if(code == 200)
        {
         ArrayRemove(g_queue, 0, k);
         g_sent += k;
         g_status = "";
         continue;
        }
      if(code == 400)
        {
         // a malformed event would block the queue forever: log and drop this batch
         Print("QT Master: máy chủ từ chối sự kiện (400), bỏ qua: ", resp);
         ArrayRemove(g_queue, 0, k);
         continue;
        }
      g_status = "Gửi lỗi, sẽ thử lại: " + g_api.lastError;
      SaveQueue();
      return;
     }
   SaveQueue();
  }

void SaveQueue()
  {
   int h = FileOpen(QueueFile(), FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   for(int i = 0; i < ArraySize(g_queue); i++) FileWriteString(h, g_queue[i] + "\n");
   FileClose(h);
  }

void LoadQueue()
  {
   if(!FileIsExist(QueueFile())) return;
   int h = FileOpen(QueueFile(), FILE_READ | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   while(!FileIsEnding(h))
     {
      string line = FileReadString(h);
      if(StringLen(line) > 2) Enqueue(line);
     }
   FileClose(h);
   if(ArraySize(g_queue) > 0) Print("QT Master: gửi lại ", ArraySize(g_queue), " sự kiện chưa gửi từ lần chạy trước");
  }

//+------------------------------------------------------------------+
//| Broker M1 bars for the cloud chart                                |
//+------------------------------------------------------------------+
void ParseBarMap()
  {
   ArrayResize(g_barMap, 0);
   string parts[];
   int n = StringSplit(InpBarSymbols, ',', parts);
   for(int i = 0; i < n; i++)
     {
      string kv[];
      if(StringSplit(parts[i], '=', kv) != 2) continue;
      StringTrimLeft(kv[0]); StringTrimRight(kv[0]); StringTrimLeft(kv[1]); StringTrimRight(kv[1]);
      if(!QTSymbolExistsSimple(kv[1])) { Print("QT Master: không có symbol ", kv[1], " trên broker này, bỏ qua giá ", kv[0]); continue; }
      SymbolSelect(kv[1], true);
      int k = ArrayRange(g_barMap, 0);
      ArrayResize(g_barMap, k + 1);
      g_barMap[k][0] = kv[0];
      g_barMap[k][1] = kv[1];
     }
  }

bool QTSymbolExistsSimple(const string s) { bool custom = false; return SymbolExist(s, custom); }

void PushBars()
  {
   // broker server time -> UTC, rounded to 15 minutes
   int offset = (int)MathRound((double)(TimeTradeServer() - TimeGMT()) / 900.0) * 900;
   int count = g_barsBackfilled ? 3 : 120;   // server accepts 500 bars per call: 4 symbols x 120
   string list = "";
   for(int i = 0; i < ArrayRange(g_barMap, 0); i++)
     {
      MqlRates r[];
      int got = CopyRates(g_barMap[i][1], PERIOD_M1, 1, count, r);   // closed bars only
      for(int j = 0; j < got; j++)
         list += (list == "" ? "" : ",") + "{" + JKs("symbol", g_barMap[i][0]) + "," + JKi("t", (long)r[j].time - offset) + ","
                 + JKn("o", r[j].open) + "," + JKn("h", r[j].high) + "," + JKn("l", r[j].low) + "," + JKn("c", r[j].close) + ","
                 + JKn("v", (double)r[j].tick_volume) + "}";
     }
   if(list == "") return;
   string resp;
   if(g_api.Post("/ct-bars", "{\"bars\":[" + list + "]}", 8000, resp) == 200) g_barsBackfilled = true;
  }
//+------------------------------------------------------------------+
