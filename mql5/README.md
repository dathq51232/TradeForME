# EA MT5 cho Quant Terminal Cloud

| File | Gắn vào | Việc làm |
|---|---|---|
| `Experts/QT_MasterSender.mq5` | Terminal của tài khoản **Master** | Gửi mọi lệnh mở/đóng/đóng một phần/sửa SL-TP/lệnh chờ, ảnh chụp vị thế mỗi 30 giây, heartbeat, và nến M1 của vàng, bạc, dầu cho biểu đồ |
| `Experts/QT_Receiver.mq5` | Terminal của từng tài khoản **Receiver** | Lấy lệnh từ máy chủ (long-poll), lọc, tính lot, kiểm tra rủi ro, vào lệnh, báo kết quả, đối soát |
| `Scripts/QT_SelfTest.mq5` | Bất kỳ chart nào | Kiểm tra terminal tính chữ ký, JSON và lot giống hệt máy chủ. **Chạy trước khi dùng EA** |
| `Include/QT/*.mqh` | | Thư viện dùng chung: JSON, chữ ký HMAC, gọi API, tính lot, rủi ro |

Quy tắc tính lot, ánh xạ symbol, bộ lọc và rủi ro là bản chuyển từ `packages/shared/src/copytrade.js`. Hai bên phải cho cùng kết quả; `QT_SelfTest` chạy lại các ví dụ trong test JS.

## Cài đặt (cách nhanh)

1. Dashboard → **Tài khoản MT5** → chọn vai trò, đặt tên → **Tạo mã kết nối**. Không cần nhập login/server: EA tự nhận tài khoản đang đăng nhập.
2. Tải `QT_MasterSender.ex5` hoặc `QT_Receiver.ex5` (đã biên dịch sẵn). MT5: **File → Open Data Folder → MQL5/Experts**, chép file vào, rồi Navigator → **Expert Advisors → Refresh**.
3. **Tools → Options → Expert Advisors**: thêm `https://<project-ref>.supabase.co` vào *Allow WebRequest* (dashboard có nút chép). MT5 bắt buộc bước này với mọi EA gọi mạng.
4. Kéo EA vào **một** chart, dán mã vào ô **Mã kết nối** (hoặc *Load* file `.set`).
5. Dashboard tự đánh dấu: EA đã gọi tới, đúng tài khoản, self-test, Algo Trading, Online. Sai EA cho vai trò, dán mã vào tài khoản khác, hoặc đồng hồ lệch thì cả MT5 và dashboard đều báo rõ.
6. Trang **Copy Trading**: thêm receiver vào group, kiểm tra cấu hình, bật receiver, rồi bấm **Chạy**.

Mỗi EA tự chạy self-test (chữ ký, JSON, tính lot) khi khởi động và dừng nếu lỗi. Script `QT_SelfTest` chỉ để xem từng dòng kiểm tra.

File tải về được sinh từ `Experts/`, `Scripts/` và `Include/QT/` bằng `node mql5/build.mjs --compile` (chạy trên Windows có MT5; bundle `.mq5` là UTF-8 có BOM). `ex5.json` ghi mã băm nguồn của từng `.ex5`, nên `npm test` báo lỗi nếu sửa nguồn mà quên biên dịch lại. MT5 quá cũ có thể không chạy `.ex5` mới: cập nhật MT5, hoặc tải bản `.mq5` và bấm F7. Mục **Nâng cao** trong EA (API URL, token, secret riêng) chỉ dùng khi không có mã kết nối.

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
- Mã MQL5 đã biên dịch không lỗi (MetaEditor 64-bit) nhưng **chưa chạy thử trên tài khoản thật**. Hãy thử trên **tài khoản demo** ít nhất 2 tuần theo lộ trình thiết kế trước khi dùng tiền thật.
