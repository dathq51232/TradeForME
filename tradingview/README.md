# QT All-in-One cho TradingView (Pine v6)

`QT_AllInOne.pine` gộp phần đọc biểu đồ của dự án thành **một** indicator, dùng được trên tài khoản TradingView miễn phí.
Đây là bản viết lại bằng Pine Script của `packages/core/src` (trend.js, patterns.js, rsi-tools.js), cùng quy tắc
với web app. Pine tính từng nến một, nên kết quả gần giống web chứ không giống từng điểm.

| Nhóm | Nội dung |
|---|---|
| 1 · Trend dài hạn | EMA50 / EMA200 trên nến **đã đóng** của khung chọn (mặc định D1), trạng thái mới cần 2 nến xác nhận; đánh dấu đổi trend, golden / death cross |
| 2 · Bảng trend | Vàng, bạc, WTI, Brent, Bitcoin và mã đang xem: trend, khoảng cách tới EMA200, độ dốc EMA200 20 phiên |
| 3 · Mô hình nến | Búa, nhấn chìm, harami, xuyên thủng, mây đen, sao mai / sao hôm, ba chàng lính / ba con quạ, nhíp, marubozu, (doji) |
| 4 · RSI | RSI + MA, trendline trên RSI và điểm phá, hội tụ / phân kỳ (thường và ẩn, vẽ cả trên RSI lẫn trên giá), volume đột biến |
| 5 · Mức giá | Key level từ giá đóng cửa, đỉnh / đáy / đóng cửa ngày và tuần trước, đóng cửa tháng trước, phiên Sydney / Tokyo / London / New York |

## Cài đặt
1. TradingView → mở biểu đồ → **Pine Editor** (dưới cùng).
2. Xoá nội dung mẫu, dán toàn bộ `QT_AllInOne.pine`, bấm **Save** rồi **Add to chart**.
3. Indicator nằm ở một khung riêng (RSI); mọi thứ thuộc về giá được vẽ thẳng lên biểu đồ giá.
4. Bật / tắt từng nhóm trong **Settings → Inputs**. "Hiện chữ" tắt thì chỉ còn mũi tên, rê chuột để xem tên.

## Cảnh báo
Alert → Condition: **QT AIO** → chọn một trong: trend chuyển tăng / giảm / đi ngang, golden cross, death cross, giá
cắt EMA200, mô hình nến tăng / giảm, hội tụ / phân kỳ RSI, RSI phá trendline, volume đột biến. Gói miễn phí giới hạn
số cảnh báo và không có webhook, nên cảnh báo Telegram vẫn do web app gửi.

## Lưu ý
- Bảng trend cần đủ 200 nến D1 trong lịch sử biểu đồ. Ở khung nhỏ (M1–M15) TradingView có thể không tải đủ ngày,
  bảng sẽ báo "Chưa đủ dữ liệu": xem bảng ở H4 hoặc D1.
- Mã trong bảng mặc định: `OANDA:XAUUSD`, `OANDA:XAGUSD`, `TVC:USOIL`, `TVC:UKOIL`, `BINANCE:BTCUSDT` (đổi được trong Inputs).
- Chỉ để tham khảo, không phải khuyến nghị.
