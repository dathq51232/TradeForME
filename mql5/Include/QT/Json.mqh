//+------------------------------------------------------------------+
//| QT/Json.mqh — small JSON reader and writer helpers for the EAs.   |
//| Reader: CQJ tree (null, bool, number, string, array, object).     |
//| Writer: JStr/JNum/JInt build JSON text by concatenation.          |
//+------------------------------------------------------------------+
#property strict

enum ENUM_QJ { QJ_NULL, QJ_BOOL, QJ_NUM, QJ_STR, QJ_ARR, QJ_OBJ };

class CQJ
  {
public:
   ENUM_QJ           type;
   bool              b;
   double            n;
   string            s;
   string            key;
   CQJ              *items[];

                     CQJ(void) { type = QJ_NULL; b = false; n = 0; }
                    ~CQJ(void) { Clear(); }
   void              Clear(void)
     {
      for(int i = 0; i < ArraySize(items); i++)
         if(CheckPointer(items[i]) == POINTER_DYNAMIC) delete items[i];
      ArrayResize(items, 0);
     }
   int               Size(void) { return ArraySize(items); }
   CQJ              *At(int i) { return (i >= 0 && i < ArraySize(items)) ? items[i] : NULL; }
   CQJ              *Get(const string k)
     {
      for(int i = 0; i < ArraySize(items); i++)
         if(items[i].key == k) return items[i];
      return NULL;
     }
   bool              Has(const string k) { CQJ *v = Get(k); return v != NULL && v.type != QJ_NULL; }
   double            Num(const string k, double def = 0.0)
     {
      CQJ *v = Get(k);
      if(v == NULL) return def;
      if(v.type == QJ_NUM) return v.n;
      if(v.type == QJ_STR) return StringToDouble(v.s);
      return def;
     }
   long              Long(const string k, long def = 0) { return Has(k) ? (long)MathRound(Num(k)) : def; }
   string            Str(const string k, const string def = "")
     {
      CQJ *v = Get(k);
      if(v == NULL || v.type == QJ_NULL) return def;
      if(v.type == QJ_STR) return v.s;
      if(v.type == QJ_NUM) return JNumText(v.n);
      if(v.type == QJ_BOOL) return v.b ? "true" : "false";
      return def;
     }
   bool              Bool(const string k, bool def = false)
     {
      CQJ *v = Get(k);
      if(v == NULL || v.type != QJ_BOOL) return def;
      return v.b;
     }

   //--- parse a whole document; false on syntax error
   bool              Parse(const string text)
     {
      Clear(); type = QJ_NULL;
      int p = 0;
      if(!ParseValue(text, p)) return false;
      SkipWs(text, p);
      return p == StringLen(text);
     }

   static string     JNumText(double v)
     {
      if(v == MathRound(v) && MathAbs(v) < 1e15) return StringFormat("%.0f", v);
      string s = DoubleToString(v, 8);
      int len = StringLen(s);
      while(len > 0 && StringGetCharacter(s, len - 1) == '0') len--;
      if(len > 0 && StringGetCharacter(s, len - 1) == '.') len--;
      return StringSubstr(s, 0, len);
     }

private:
   void              SkipWs(const string &t, int &p)
     {
      int len = StringLen(t);
      while(p < len)
        {
         ushort c = StringGetCharacter(t, p);
         if(c == ' ' || c == '\t' || c == '\n' || c == '\r') p++;
         else break;
        }
     }
   bool              ParseValue(const string &t, int &p)
     {
      SkipWs(t, p);
      if(p >= StringLen(t)) return false;
      ushort c = StringGetCharacter(t, p);
      if(c == '{') return ParseObject(t, p);
      if(c == '[') return ParseArray(t, p);
      if(c == '"') { type = QJ_STR; return ParseString(t, p, s); }
      if(StringSubstr(t, p, 4) == "true") { type = QJ_BOOL; b = true; p += 4; return true; }
      if(StringSubstr(t, p, 5) == "false") { type = QJ_BOOL; b = false; p += 5; return true; }
      if(StringSubstr(t, p, 4) == "null") { type = QJ_NULL; p += 4; return true; }
      return ParseNumber(t, p);
     }
   bool              ParseNumber(const string &t, int &p)
     {
      int start = p, len = StringLen(t);
      while(p < len)
        {
         ushort c = StringGetCharacter(t, p);
         if((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') p++;
         else break;
        }
      if(p == start) return false;
      type = QJ_NUM;
      n = StringToDouble(StringSubstr(t, start, p - start));
      return true;
     }
   bool              ParseString(const string &t, int &p, string &out)
     {
      out = "";
      p++; // opening quote
      int len = StringLen(t);
      while(p < len)
        {
         ushort c = StringGetCharacter(t, p);
         if(c == '"') { p++; return true; }
         if(c == '\\')
           {
            p++;
            if(p >= len) return false;
            ushort e = StringGetCharacter(t, p);
            if(e == 'n') out += "\n";
            else if(e == 'r') out += "\r";
            else if(e == 't') out += "\t";
            else if(e == 'b') out += ShortToString(8);
            else if(e == 'f') out += ShortToString(12);
            else if(e == 'u')
              {
               if(p + 4 >= len) return false;
               out += ShortToString((ushort)HexToInt(StringSubstr(t, p + 1, 4)));
               p += 4;
              }
            else out += ShortToString(e); // \" \\ \/
            p++;
            continue;
           }
         out += ShortToString(c);
         p++;
        }
      return false;
     }
   bool              ParseArray(const string &t, int &p)
     {
      type = QJ_ARR;
      p++;
      SkipWs(t, p);
      if(p < StringLen(t) && StringGetCharacter(t, p) == ']') { p++; return true; }
      while(p < StringLen(t))
        {
         CQJ *v = new CQJ();
         int k = ArraySize(items);
         ArrayResize(items, k + 1);
         items[k] = v;
         if(!v.ParseValue(t, p)) return false;
         SkipWs(t, p);
         if(p >= StringLen(t)) return false;
         ushort c = StringGetCharacter(t, p);
         p++;
         if(c == ']') return true;
         if(c != ',') return false;
        }
      return false;
     }
   bool              ParseObject(const string &t, int &p)
     {
      type = QJ_OBJ;
      p++;
      SkipWs(t, p);
      if(p < StringLen(t) && StringGetCharacter(t, p) == '}') { p++; return true; }
      while(p < StringLen(t))
        {
         SkipWs(t, p);
         if(p >= StringLen(t) || StringGetCharacter(t, p) != '"') return false;
         string k;
         if(!ParseString(t, p, k)) return false;
         SkipWs(t, p);
         if(p >= StringLen(t) || StringGetCharacter(t, p) != ':') return false;
         p++;
         CQJ *v = new CQJ();
         v.key = k;
         int i = ArraySize(items);
         ArrayResize(items, i + 1);
         items[i] = v;
         if(!v.ParseValue(t, p)) return false;
         SkipWs(t, p);
         if(p >= StringLen(t)) return false;
         ushort c = StringGetCharacter(t, p);
         p++;
         if(c == '}') return true;
         if(c != ',') return false;
        }
      return false;
     }
   static int        HexToInt(const string h)
     {
      int v = 0;
      for(int i = 0; i < StringLen(h); i++)
        {
         ushort c = StringGetCharacter(h, i);
         int d = (c >= '0' && c <= '9') ? c - '0' : (c >= 'a' && c <= 'f') ? c - 'a' + 10 : (c >= 'A' && c <= 'F') ? c - 'A' + 10 : 0;
         v = v * 16 + d;
        }
      return v;
     }
  };

//--- writer helpers ------------------------------------------------
string JStr(const string s)
  {
   string out = "\"";
   for(int i = 0; i < StringLen(s); i++)
     {
      ushort c = StringGetCharacter(s, i);
      if(c == '"') out += "\\\"";
      else if(c == '\\') out += "\\\\";
      else if(c == '\n') out += "\\n";
      else if(c == '\r') out += "\\r";
      else if(c == '\t') out += "\\t";
      else if(c < 32 || c > 126) out += StringFormat("\\u%04x", c); // keep the body ASCII: it is signed byte for byte
      else out += ShortToString(c);
     }
   return out + "\"";
  }
string JNum(double v) { return CQJ::JNumText(v); }
string JInt(long v) { return StringFormat("%I64d", v); }
string JBool(bool v) { return v ? "true" : "false"; }
//--- "key":value fragments
string JKs(const string k, const string v) { return JStr(k) + ":" + JStr(v); }
string JKn(const string k, double v) { return JStr(k) + ":" + JNum(v); }
string JKi(const string k, long v) { return JStr(k) + ":" + JInt(v); }
string JKb(const string k, bool v) { return JStr(k) + ":" + JBool(v); }
//+------------------------------------------------------------------+
