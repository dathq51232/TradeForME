# MQL5 Expert Advisors (Giai đoạn 3)

- `Experts/QT_MasterSender.mq5` — bắt `OnTradeTransaction` trên tài khoản master, gửi sự kiện tới `/functions/v1/ct-ingest`.
- `Experts/QT_Receiver.mq5` — long-poll `/ct-pull`, kiểm tra rủi ro, đặt lệnh, báo `/ct-ack`.
- `Include/QT/` — Http, Json, Hmac, Risk.

Hợp đồng dữ liệu và quy tắc tính lot / ánh xạ symbol là `packages/shared/src/copytrade.js`;
EA phải cho ra cùng kết quả với các test trong `packages/shared/test/copytrade.test.js`.
Thiết kế: `docs/THIET-KE-HE-THONG.md` §6.
