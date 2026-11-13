# Phân tích tài liệu "MT5 Copy Trading Design" và kế hoạch nâng cấp

Nguồn: `quant-terminal-mt5-copy-trading-design.md` (người dùng gửi, 13/11/2026).
Đối chiếu với: `docs/THIET-KE-HE-THONG.md` và mã đã có trong repo (Giai đoạn 0).

## 1. Kết luận nhanh

Tài liệu mới đúng hướng ở **sản phẩm và vận hành**: copy group, trạng thái kết nối chi tiết, phân biệt Pause / Stop / Emergency / Close All, máy trạng thái của tác vụ copy, risk engine, đối soát, giao diện "dark institutional". Hệ thống hiện tại thiếu những phần này, nên chúng được đưa vào.

Ở **kiến trúc kỹ thuật**, tài liệu viết cho một backend tự vận hành (Redis, WebSocket riêng, nhiều service, REST tự viết, bridge nhận lệnh đẩy từ server). Với Supabase + Vercel thì giữ nguyên kiến trúc hiện tại vì nó đã thoả mãn cùng yêu cầu với ít thành phần hơn (xem §3).

## 2. Bảng đối chiếu

| Hạng mục (mục trong tài liệu) | Đang có | Quyết định | Đợt này |
|---|---|---|---|
| Copy Group: 1 Master → nhiều Receiver (§7.1) | Chỉ có cặp `copy_links` | Thêm bảng `copy_groups` (1 group / 1 master), mỗi link thuộc 1 group | ✅ |
| Pause / Resume / Stop / Emergency Stop (§7.5, §15.3) | Chỉ có `enabled` theo link và pause toàn hệ thống | Trạng thái group + RPC `copy_group_control` có audit; `ct_pull` áp quy tắc theo trạng thái | ✅ |
| Close All là thao tác riêng, có xác nhận (§7.5) | Có kiểu sự kiện `KILL` nhưng chưa có cách phát | RPC `copy_request_close_all` yêu cầu gõ đúng tên group, phát `KILL` cho mọi receiver | ✅ |
| Chế độ lot Balance Ratio (§7.4) | fixed, multiplier, equity_ratio, risk_percent | Thêm `balance_ratio` (DB + `computeLot` + test) | ✅ |
| Bộ lọc Copy Buy/Sell/Market/Close/Modify/Partial (§8A) | Chỉ có copy_sl_tp, copy_pending | Thêm cột + hàm `shouldCopy` dùng chung cho EA | ✅ |
| Min lot, chính sách làm tròn (§8B) | Có trong `computeLot`, chưa có trong DB | Thêm `min_lot`, `below_min` | ✅ |
| Risk: max spread, drawdown, exposure, margin usage (§8C, §10) | Có max lot, max positions, daily loss, slippage | Thêm cột + hàm `riskPreCheck` có test; thêm `risk_action` | ✅ |
| Risk events, notifications (§10.2, §12) | Không có | Bảng `risk_events`, `notifications` | ✅ |
| Trạng thái kết nối chi tiết, Hedging/Netting, margin level (§6.1, §6.3) | `online/offline/paused/error` | Mở rộng trạng thái; thêm `account_type`, `margin_level`, `terminal_connected`, `trade_allowed`, `last_error`; phân biệt "bridge còn sống" với "terminal sẵn sàng giao dịch" | ✅ |
| Máy trạng thái tác vụ copy + phân loại lỗi (§9.2, §9.3) | `done/skipped/failed` | Trạng thái Received → … → Executed/Rejected/Failed/Reconciliation Required; cột `error_class` | ✅ |
| Đối soát (§9.4) | `ct_position_map` | Bảng `reconciliation_runs`, `reconciliation_items`; logic chạy ở Giai đoạn 3 | Bảng ✅, logic ⏳ |
| Snapshot tài khoản cho Analytics (§12) | Chỉ giá trị hiện tại | Bảng `account_snapshots` | ✅ |
| App shell tối, sidebar 10 mục, Dashboard KPI (§3, §4) | Trang dashboard đơn giản | Làm app shell, Dashboard KPI, trang MT5 Accounts (thêm tài khoản, cấp token EA), Copy Trading (điều khiển group) | ✅ |
| Trading Charts (§5) | Chưa có | Giai đoạn 1 | ⏳ |
| Positions, Orders & History, Analytics, Activity Logs | Chưa có | Có mục trên sidebar, đánh dấu "sắp có" | ⏳ |
| Workspaces / tổ chức (§12) | Theo `owner_id` | Hoãn, chỉ thêm khi có nhiều người vận hành chung | ❌ hoãn |

## 3. Những điểm giữ khác tài liệu, và lý do

1. **Không lưu mật khẩu MT5, kể cả mã hoá** (tài liệu §6.2, bảng `mt5_credentials`). EA chạy ngay trong terminal đã đăng nhập, nên server không cần mật khẩu. Mỗi EA chỉ giữ một token, server chỉ lưu SHA-256 của token, cộng với khoá HMAC để ký từng request. Như vậy cả lớp rủi ro lộ mật khẩu bị loại bỏ.
2. **EA kéo lệnh, server không đẩy lệnh tới bridge** (tài liệu §11.4). EA receiver gọi HTTPS ra ngoài (long-poll `/ct-pull`), nên VPS không phải mở cổng nào. Điều này đáp ứng đúng yêu cầu §15.1 của chính tài liệu: không mở cổng bridge ra Internet.
3. **Không dùng Redis/queue riêng.** Bảng `ct_events` có `seq` tăng dần theo từng master và `event_uid` duy nhất, nên nó vừa là hàng đợi vừa chống trùng. Mỗi receiver giữ con trỏ `seq` của mình.
4. **Không viết WebSocket service hay REST CRUD riêng.** Supabase Realtime phát thay đổi của bảng; RLS + RPC thay cho phần lớn endpoint ở §14. Edge Functions chỉ phục vụ EA (`ct-ingest`, `ct-pull`, `ct-ack`, `ct-heartbeat`).
5. **Modular monolith**: đồng ý với tài liệu (§11.3, quyết định 7). Mỗi module là một thư mục trong `supabase/functions` và `packages/shared`.

## 4. Quy tắc phát lệnh theo trạng thái group (đã cài trong `ct_pull`)

| Trạng thái group | OPEN, PENDING_* | MODIFY, CLOSE, PARTIAL_CLOSE, PENDING_DELETE | KILL (Close All) |
|---|---|---|---|
| `running` | phát | phát | phát |
| `paused` | bỏ qua | phát (để receiver không giữ vị thế mồ côi) | phát |
| `stopped` | bỏ qua | bỏ qua | phát |
| `emergency` | bỏ qua | bỏ qua | phát |
| Link `enabled = false` | bỏ qua | bỏ qua | phát |

Sự kiện bị bỏ qua vẫn được trả về kèm `skip_reason`, để EA ghi nhận và tiến con trỏ. Nhờ vậy lệnh mở phát ra lúc tạm dừng sẽ không bị thực thi muộn khi bật lại (tài liệu §13.3 "Receiver offline").

Pause toàn hệ thống (`app_settings.copy_global_pause`) được xử lý như `paused`.

Thoát khỏi `emergency` bắt buộc ghi lý do.

## 5. Các đợt tiếp theo

1. **Giai đoạn 1: Trading Charts.** Biểu đồ nến, watchlist, chỉ báo từ `packages/core`, lưu layout.
2. **Giai đoạn 3: EA + Edge Functions.** `ct-ingest`, `ct-pull`, `ct-ack`, `ct-heartbeat`; EA Master/Receiver; đối soát mỗi 30 giây; ghi `risk_events`.
3. Các trang Positions, Orders & History, Activity Logs (đọc từ bảng đã có), rồi Analytics từ `account_snapshots`.

## 6. Câu hỏi còn mở

- Ai vận hành: một mình anh/chị, hay nhiều người cùng quản lý? Câu trả lời quyết định có cần `workspaces` hay không.
- Khi vượt giới hạn rủi ro, mặc định nên **từ chối lệnh** (đang đặt) hay **tạm dừng receiver**?
- Master có đặt lệnh chờ (pending) không? Nếu không, có thể tắt nhánh đó để giảm rủi ro.
