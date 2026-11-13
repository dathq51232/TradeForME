//+------------------------------------------------------------------+
//| QT_SelfTest.mq5 — optional: the EAs already run these checks at  |
//| start-up. Run it on any chart to see every check in the Experts  |
//| log.                                                             |
//+------------------------------------------------------------------+
#property strict

#include <QT\SelfTest.mqh>

void OnStart()
  {
   string r = QTSelfTest(true);
   Print(r == "ok" ? "QT self-test: tất cả OK" : "QT self-test: " + r + " — KHÔNG dùng EA trên tài khoản thật");
  }
//+------------------------------------------------------------------+
