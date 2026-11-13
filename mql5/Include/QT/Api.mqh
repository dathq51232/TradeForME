//+------------------------------------------------------------------+
//| QT/Api.mqh — signed HTTPS calls to the Quant Terminal Edge        |
//| Functions. Signature = hex HMAC-SHA256(secret, ts + "\n" + body), |
//| matching supabase/functions/_shared/ea.ts.                        |
//+------------------------------------------------------------------+
#property strict

#include "Json.mqh"

#define QT_EA_VERSION "1.0.0"

//--- SHA-256 of a byte array
void QTSha256(const uchar &data[], uchar &out[])
  {
   uchar nokey[];
   ArrayResize(nokey, 0);
   CryptEncode(CRYPT_HASH_SHA256, data, nokey, out);
  }

//--- UTF-8 bytes of a string, without the terminating zero
void QTBytes(const string s, uchar &out[])
  {
   int n = StringToCharArray(s, out, 0, WHOLE_ARRAY, CP_UTF8);
   if(n > 0 && out[n - 1] == 0) ArrayResize(out, n - 1);
  }

string QTHex(const uchar &b[])
  {
   string h = "";
   for(int i = 0; i < ArraySize(b); i++) h += StringFormat("%02x", b[i]);
   return h;
  }

//--- RFC 2104 HMAC with SHA-256
string QTHmacSha256Hex(const string secret, const string message)
  {
   uchar key[], msg[];
   QTBytes(secret, key);
   QTBytes(message, msg);
   if(ArraySize(key) > 64)
     {
      uchar hk[];
      QTSha256(key, hk);
      ArrayFree(key);
      ArrayCopy(key, hk);
     }
   uchar k0[];
   ArrayResize(k0, 64);
   ArrayInitialize(k0, 0);
   ArrayCopy(k0, key, 0, 0, ArraySize(key));

   uchar inner[];
   ArrayResize(inner, 64 + ArraySize(msg));
   for(int i = 0; i < 64; i++) inner[i] = (uchar)(k0[i] ^ 0x36);
   ArrayCopy(inner, msg, 64, 0, ArraySize(msg));
   uchar ih[];
   QTSha256(inner, ih);

   uchar outer[];
   ArrayResize(outer, 64 + ArraySize(ih));
   for(int i = 0; i < 64; i++) outer[i] = (uchar)(k0[i] ^ 0x5c);
   ArrayCopy(outer, ih, 64, 0, ArraySize(ih));
   uchar oh[];
   QTSha256(outer, oh);
   return QTHex(oh);
  }

//--- milliseconds since 1970 UTC (second precision is enough for the 60 s window)
long QTNowMs(void) { return (long)TimeGMT() * 1000; }

class CQTApi
  {
private:
   string            m_base;
   string            m_token;
   string            m_secret;
public:
   string            lastError;
   int               lastStatus;

   void              Init(const string base, const string token, const string secret)
     {
      m_base = base;
      while(StringLen(m_base) > 0 && StringGetCharacter(m_base, StringLen(m_base) - 1) == '/')
         m_base = StringSubstr(m_base, 0, StringLen(m_base) - 1);
      m_token = token;
      m_secret = secret;
     }
   bool              Configured(void) { return StringLen(m_token) == 64 && StringLen(m_secret) == 64 && StringFind(m_base, "https://") == 0; }

   //--- POST a JSON body; returns HTTP status or -1 (network / WebRequest not allowed)
   int               Post(const string path, const string body, const int timeoutMs, string &response)
     {
      string ts = StringFormat("%I64d", QTNowMs());
      string headers = "Content-Type: application/json\r\n"
                       "X-QT-Token: " + m_token + "\r\n"
                       "X-QT-Timestamp: " + ts + "\r\n"
                       "X-QT-Signature: " + QTHmacSha256Hex(m_secret, ts + "\n" + body) + "\r\n"
                       "X-QT-Version: " + QT_EA_VERSION + "\r\n";
      char data[], result[];
      int n = StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
      if(n > 0 && data[n - 1] == 0) ArrayResize(data, n - 1);
      string rh;
      ResetLastError();
      int code = WebRequest("POST", m_base + path, headers, timeoutMs, data, result, rh);
      lastStatus = code;
      if(code == -1)
        {
         int err = GetLastError();
         lastError = err == 4014
                     ? "Chưa cho phép WebRequest: Tools > Options > Expert Advisors > Allow WebRequest, thêm " + m_base
                     : "Lỗi mạng (WebRequest " + IntegerToString(err) + ")";
         response = "";
         return -1;
        }
      response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
      if(code >= 400)
        {
         CQJ j;
         lastError = (j.Parse(response) ? j.Str("error") + " " + j.Str("message") : "HTTP " + IntegerToString(code));
        }
      else lastError = "";
      return code;
     }
  };

//--- "QT1.<project-ref>.<token>.<secret>" (the dashboard's connection code) -> url, token, secret
bool QTParseConnection(string code, string &url, string &token, string &secret)
  {
   StringTrimLeft(code);
   StringTrimRight(code);
   string p[];
   if(StringSplit(code, '.', p) != 4 || p[0] != "QT1") return false;
   if(StringLen(p[1]) < 10 || StringLen(p[2]) != 64 || StringLen(p[3]) != 64) return false;
   url = "https://" + p[1] + ".supabase.co/functions/v1";
   token = p[2];
   secret = p[3];
   return true;
  }

//--- configure from the connection code, or from the advanced inputs when no code is given; "" = ok
string QTSetup(CQTApi &api, const string code, const string url, const string token, const string secret)
  {
   string u = url, t = token, s = secret;
   if(StringLen(code) > 0 && !QTParseConnection(code, u, t, s))
      return "Mã kết nối không đúng. Chép lại nguyên dòng bắt đầu bằng QT1. từ trang Tài khoản MT5.";
   api.Init(u, t, s);
   if(!api.Configured()) return "Chưa có mã kết nối. Dán mã từ trang Tài khoản MT5 vào ô \"Mã kết nối\".";
   return "";
  }

//--- first call at start-up: explains the usual setup mistakes in plain words
bool QTStartupCheck(CQTApi &api, const string who)
  {
   string resp;
   int code = api.Post("/ct-heartbeat", QTHeartbeatBody(""), 8000, resp);
   if(code == 200) { Print(who, ": đã kết nối máy chủ"); return true; }
   if(code == -1) Alert(who, ": ", api.lastError);
   else if(code == 401) Alert(who, ": máy chủ từ chối (", api.lastError, "). Mã kết nối sai hoặc đã được cấp lại; nếu báo CLOCK_SKEW thì chỉnh lại đồng hồ máy.");
   else if(code == 403) Alert(who, ": ", api.lastError);
   else if(code == 426) Alert(who, ": cần tải bản EA mới. ", api.lastError);
   else Alert(who, ": lỗi máy chủ ", code, " ", api.lastError);
   return false;
  }

//--- live account state for /ct-heartbeat (both EAs)
string QTHeartbeatBody(const string lastError)
  {
   bool tradeAllowed = TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && MQLInfoInteger(MQL_TRADE_ALLOWED)
                       && AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) && AccountInfoInteger(ACCOUNT_TRADE_EXPERT);
   bool hedging = AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING;
   return "{" + JKn("balance", AccountInfoDouble(ACCOUNT_BALANCE)) + ","
          + JKn("equity", AccountInfoDouble(ACCOUNT_EQUITY)) + ","
          + JKn("margin", AccountInfoDouble(ACCOUNT_MARGIN)) + ","
          + JKn("margin_level", AccountInfoDouble(ACCOUNT_MARGIN_LEVEL)) + ","
          + JKn("floating_pl", AccountInfoDouble(ACCOUNT_PROFIT)) + ","
          + JKi("open_positions", PositionsTotal()) + ","
          + JKs("currency", AccountInfoString(ACCOUNT_CURRENCY)) + ","
          + JKs("account_type", hedging ? "hedging" : "netting") + ","
          + JKb("terminal_connected", (bool)TerminalInfoInteger(TERMINAL_CONNECTED)) + ","
          + JKb("trade_allowed", tradeAllowed) + ","
          + JKs("ea_version", QT_EA_VERSION) + ","
          + JKs("last_error", lastError) + "}";
  }
//+------------------------------------------------------------------+
