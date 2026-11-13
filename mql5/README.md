# EA MT5 cho Quant Terminal Cloud

| File | Gắn vào | Việc làm |
|---|---|---|
| `Experts/QT_MasterSender.mq5` | Terminal của tài khoản **Master** | Gửi mọi lệnh mở/đóng/đóng một phần/sửa SL-TP/lệnh chờ, ảnh chụp vị thế mỗi 30 giây, heartbeat, và nến M1 của vàng, bạc, dầu cho biểu đồ |
| `Experts/QT_Receiver.mq5` | Terminal của từng tài khoản **Receiver** | Lấy lệnh từ máy chủ (long-poll), lọc, tính lot, kiểm tra rủi ro, vào lệnh, báo kết quả, đối soát |
| `Scripts/QT_SelfTest.mq5` | Bất kỳ chart nào | Kiểm tra terminal tính chữ ký, JSON và lot giống hệt máy chủ. **Chạy trước khi dùng EA** |
| `Include/QT/*.mqh` | | Thư viện dùng chung: JSON, chữ ký HMAC, gọi API, tính lot, rủi ro |

Quy tắc tính lot, ánh xạ symbol, bộ lọc và rủi ro là bản chuyển từ `packages/shared/src/copytrade.js`. Hai bên phải cho cùng kết quả; `QT_SelfTest` chạy lại các ví dụ trong test JS.

## Cài đặt

1. Trong MT5: **File → Open Data Folder**, chép thư mục `Experts`, `Include`, `Scripts` này vào thư mục `MQL5`.
2. Mở MetaEditor, biên dịch `QT_SelfTest.mq5`, `QT_MasterSender.mq5`, `QT_Receiver.mq5` (F7). Phải không có lỗi.
3. Kéo `QT_SelfTest` vào một chart; tab **Experts** phải ghi `QT self-test: tất cả OK`.
4. **Tools → Options → Expert Advisors**: bật *Allow algorithmic trading*, thêm vào *Allow WebRequest for listed URL*:
   `https://<project-ref>.supabase.co`
5. Trên dashboard → **Tài khoản MT5** → tạo tài khoản, chép **EA token** và **HMAC secret** (chỉ hiện một lần).
6. Gắn EA vào **một** chart (mỗi terminal một tài khoản, một EA):
   - `InpApiUrl` = `https://<project-ref>.supabase.co/functions/v1`
   - `InpToken`, `InpSecret` = giá trị vừa chép.
7. Sau vài giây, dashboard hiện tài khoản **Online**, kèm loại tài khoản (Hedging/Netting), balance, equity.
8. Ở trang **Copy Trading**: thêm receiver vào group của master, kiểm tra cấu hình, bật receiver, rồi bấm **Chạy**.

Đồng hồ máy chạy MT5 phải đúng (lệch tối đa 60 giây), vì máy chủ từ chối yêu cầu có thời gian lệch để chống phát lại.

## Cách hoạt động

- **Master** bắt `OnTradeTransaction`, đưa sự kiện vào hàng đợi (lưu ra file nếu mất mạng), gửi theo lô tới `/ct-ingest`. Mỗi sự kiện có `event_uid` riêng nên gửi lại không tạo trùng.
- **Receiver** gọi `/ct-pull` (chờ tối đa 20 giây), nhận sự kiện theo `seq` và cấu hình hiện hành của link. Con trỏ `seq` lưu ra file, nên khởi động lại không xử lý lại. Receiver mới bắt đầu từ thời điểm hiện tại, không chạy lại lịch sử.
- Mỗi vị thế copy có **magic** riêng theo master và **comment** `QT#<ticket master>`. Trước khi mở, receiver kiểm tra đã có vị thế mang tag đó chưa, nên không bao giờ mở trùng.
- Lệnh mở bị lỗi **không được thử lại mù quáng**: receiver kiểm tra lại xem broker đã nhận lệnh chưa rồi mới báo thất bại.
- **Đối soát** theo ảnh chụp 30 giây của master. Vị thế master đã đóng mà receiver còn mở thì receiver tự đóng, nếu đang bật "Copy đóng lệnh". Vị thế master có mà receiver không có thì chỉ báo lên dashboard một lần, **không mở bù muộn**.
- Khi vượt giới hạn rủi ro, receiver làm theo hành động đã cấu hình. Với "tạm dừng receiver" hoặc "tạm dừng group", máy chủ ghi trạng thái nên vẫn giữ sau khi EA khởi động lại. "Chờ duyệt thủ công" chưa có, hiện được xử lý như từ chối.

## Giới hạn hiện tại

- Thiết kế cho master **Hedging**. Trên tài khoản Netting, thêm khối lượng vào vị thế có sẵn và lệnh đảo chiều chưa được copy đúng.
- SL/TP được copy theo **giá tuyệt đối** của master. Hai broker báo giá lệch nhau vài point thì SL/TP lệch tương ứng.
- Khi chọn "Đảo chiều", SL/TP và lệnh sửa SL/TP không được copy.
- Mã MQL5 **chưa được biên dịch và chạy thử** trong môi trường phát triển (không có MetaEditor). Hãy chạy `QT_SelfTest`, rồi thử trên **tài khoản demo** ít nhất 2 tuần theo lộ trình thiết kế trước khi dùng tiền thật.
