# Thiết kế hệ thống — Quant Terminal Cloud

> Phiên bản 0.1 · 13/11/2026 · Người lập: Trưởng phòng CNTT
> Phạm vi: nền tảng biểu đồ kiểu TradingView + tổng hợp tin tức tác động **Vàng (XAU) / BTC / Dầu (WTI, Brent)** + **quản lý copy trade MT5** (1 master → nhiều receiver).
> Hạ tầng bắt buộc: **Supabase** (Postgres, Auth, Realtime, Edge Functions, pg_cron), **Vercel** (frontend + API nhẹ), **GitHub** (mã nguồn, CI/CD).

---

## 1. Hiện trạng

Thư mục `quant-terminal-main` là bản **Quant Terminal** (MIT) chạy cục bộ: Node.js không phụ thuộc, `server.js` + `lib/*` lấy dữ liệu (Binance, Yahoo, Nasdaq, Forex Factory), frontend thuần JS dùng **Lightweight Charts**, lưu trữ bằng file trong `data/`.

| Có thể tái sử dụng | Ghi chú |
|---|---|
| `public/lib/indicators.js`, `series.js`, `backtest.js`, `quant.js`, `seasonals.js` | JS thuần, không phụ thuộc DOM → chuyển nguyên vào `packages/core` |
| `public/js/chart.js`, `drawings.js`, `volume-profile.js` | Bọc lại thành React component |
| `lib/providers.js`, `lib/feeds.js` | Logic lấy nến + fallback → chuyển thành Route Handler trên Vercel |
| `lib/market-info.js` (news, lịch kinh tế) | Làm nguồn đầu vào cho pipeline tin tức |
| `lib/alerts.js` + format rule JSON | Giữ nguyên format, chạy phía server bằng pg_cron |
| `test/*` (node:test) | Giữ làm bộ test cho `packages/core` |

Điểm phải thay: lưu file → Postgres; chạy 1 máy → đa người dùng có đăng nhập; alert chỉ chạy khi mở máy → chạy trên cloud.

**Giấy phép:** giữ `LICENSE`/`NOTICE` gốc (MIT) và logo ghi công của Lightweight Charts (Apache 2.0). Không dùng tên, logo, giao diện nhận diện của TradingView.

---

## 2. Yêu cầu

### 2.1 Chức năng

| Mã | Phân hệ | Yêu cầu |
|---|---|---|
| F1 | Biểu đồ | Nến nhiều khung (1m→1M), 87 chỉ báo sẵn có, công cụ vẽ, multi-layout, watchlist, lưu layout theo tài khoản |
| F2 | Biểu đồ | Dữ liệu XAUUSD, BTCUSDT, WTI/Brent; đánh dấu tin tức quan trọng lên trục thời gian của biểu đồ |
| F3 | Tin tức | Thu thập tin từ nhiều nguồn mỗi 2–5 phút, chống trùng, phân loại theo tài sản |
| F4 | Tin tức | Chấm **điểm tác động** (1–5) và **hướng** (tăng/giảm/trung tính) cho từng tài sản, kèm lý do ngắn |
| F5 | Tin tức | Lịch kinh tế (CPI, NFP, FOMC, EIA tồn kho dầu, OPEC+…) với actual/forecast/previous |
| F6 | Tin tức | Đo phản ứng giá thực tế 5m/15m/1h sau tin để kiểm chứng điểm tác động |
| F7 | Tin tức | Đẩy realtime lên web + cảnh báo Telegram/Discord với tin tác động ≥ 4 |
| C1 | Copy trade | Đăng ký tài khoản MT5 vai trò **Master** hoặc **Receiver**, cấp token cho EA |
| C2 | Copy trade | Sao chép mở / sửa SL-TP / đóng / đóng một phần / lệnh chờ từ master sang mọi receiver đang bật |
| C3 | Copy trade | Cấu hình theo từng receiver: cách tính lot, ánh xạ symbol, đảo chiều, lọc symbol, giới hạn rủi ro |
| C4 | Copy trade | Dashboard: trạng thái online, equity, lệnh đang mở, độ trễ, trượt giá, lịch sử, log lỗi |
| C5 | Copy trade | Nút **dừng khẩn cấp** (toàn hệ thống / từng receiver), có tùy chọn đóng hết lệnh đã copy |
| C6 | Copy trade | Đối soát định kỳ: phát hiện lệnh lệch giữa master và receiver và xử lý |

### 2.2 Phi chức năng

| Tiêu chí | Mục tiêu giai đoạn 1 |
|---|---|
| Quy mô | 1–5 master, ≤ 50 receiver, ≤ 500 người dùng web |
| Độ trễ copy | master khớp lệnh → receiver gửi lệnh: **p50 < 500 ms, p95 < 1,5 s** |
| Độ tin cậy copy | Không mất lệnh, không nhân đôi lệnh (idempotent), tự đồng bộ lại sau khi mất mạng |
| Độ trễ tin | Tin xuất hiện ở nguồn → hiển thị < 5 phút; lịch kinh tế actual < 1 phút |
| Khả dụng | 99,5 % (giới hạn bởi gói Supabase/Vercel) |
| Bảo mật | Không lưu mật khẩu MT5; token EA băm; RLS trên mọi bảng |
| Chi phí | Supabase Pro + Vercel Pro ≈ 45–60 USD/tháng + chi phí LLM chấm tin |

### 2.3 Ràng buộc kỹ thuật quan trọng

1. **Vercel là serverless**: không giữ được WebSocket lâu, không chạy tiến trình nền. → Không đặt engine copy trade hay job thu tin lên Vercel.
2. **MT5 không có API cloud chính thức.** Lệnh chỉ được đặt từ bên trong terminal MT5 (EA viết bằng MQL5) hoặc qua thư viện Python `MetaTrader5` trên cùng máy Windows. → Mỗi tài khoản cần một terminal MT5 đang chạy (máy cá nhân hoặc VPS Windows), cài EA của ta.
3. **MQL5 `WebRequest`** chỉ gọi HTTP(S) đồng bộ, URL phải nằm trong danh sách cho phép của terminal; không có WebSocket sẵn. → Giao tiếp EA ↔ cloud bằng HTTP polling / long-poll.

---

## 3. Kiến trúc tổng thể

```
                         ┌────────────────────────── VERCEL ──────────────────────────┐
  Trình duyệt ──HTTPS──► │ Next.js (App Router)                                        │
     ▲   ▲               │  • UI biểu đồ, tin tức, dashboard copy trade                │
     │   │               │  • /api/bars  (proxy + cache CDN nến vàng/dầu/BTC)          │
     │   │               │  • /api/admin/* (thao tác cần service-role)                 │
     │   │               └───────────────┬────────────────────────────────────────────┘
     │   │ WebSocket trực tiếp           │ supabase-js
     │   └── Binance (tick BTC)          ▼
     │                    ┌──────────────────────────── SUPABASE ───────────────────────────┐
     └── Realtime (tin, ──┤ Auth (email/OAuth)    Postgres + RLS     Storage (ảnh biểu đồ)   │
         trạng thái EA)   │ Realtime              pg_cron ──┐                               │
                          │ Edge Functions:                 ▼                               │
                          │   news-ingest  ──► news-score (LLM) ──► notify (Telegram)       │
                          │   econ-calendar  price-reaction  alerts-eval                    │
                          │   ct-ingest  ct-pull  ct-ack  ct-heartbeat  ct-reconcile        │
                          └───────▲───────────────────────────────▲─────────────────────────┘
                                  │ HTTPS POST (HMAC)             │ HTTPS long-poll + ACK
                    ┌─────────────┴──────────┐        ┌───────────┴──────────────┐
                    │ MT5 Master + EA        │        │ MT5 Receiver + EA  (×N)  │
                    │ QT_MasterSender.mq5    │        │ QT_Receiver.mq5          │
                    │ (VPS Windows)          │        │ (VPS Windows / máy KH)   │
                    └────────────────────────┘        └──────────────────────────┘

   GitHub: monorepo ── PR ──► Vercel Preview + Supabase Branch ── merge main ──► Production
```

### 3.1 Phân vai thành phần

| Thành phần | Công nghệ | Trách nhiệm |
|---|---|---|
| Web app | Next.js 15, React, TypeScript, Tailwind, Lightweight Charts | UI, SSR trang công khai (tin tức SEO), gọi Supabase trực tiếp với JWT người dùng |
| API nhẹ | Vercel Route Handlers (Node runtime) | Proxy nến có cache `s-maxage`, thao tác quản trị |
| CSDL | Supabase Postgres 15 + RLS | Nguồn sự thật duy nhất |
| Job định kỳ | `pg_cron` + `pg_net` gọi Edge Function | Thu tin, lịch kinh tế, đo phản ứng giá, đánh giá alert, dọn dữ liệu |
| Realtime | Supabase Realtime (Postgres Changes / Broadcast) | Đẩy tin mới, trạng thái EA, lệnh copy lên dashboard |
| Edge Functions | Deno/TypeScript | Endpoint cho EA, pipeline tin tức |
| EA | MQL5 | Bắt sự kiện giao dịch trên master, thực thi lệnh trên receiver |
| LLM chấm tin | Claude Haiku 5.5 (`claude-haiku-5-5`) qua Anthropic API | Phân loại + chấm tác động; rẻ, nhanh, trả về JSON |

---

## 4. Phân hệ Biểu đồ

### 4.1 Nguồn dữ liệu

| Tài sản | Nguồn chính | Dự phòng | Cách đẩy realtime |
|---|---|---|---|
| BTCUSDT | Binance REST/WS | Coinbase, Kraken (đã có trong `lib/providers.js`) | Trình duyệt mở WS trực tiếp Binance — không tốn tài nguyên server |
| XAUUSD | **Giá broker từ EA master** (đẩy nến M1) | Yahoo `GC=F` (trễ ~10 phút), Polygon/Alpaca có key | Realtime Broadcast kênh `ticks:XAUUSD` |
| WTI / Brent | Giá broker từ EA (`USOIL`, `UKOIL`) | Yahoo `CL=F`, `BZ=F` | như trên |

Ý tưởng then chốt: **vàng và dầu miễn phí thường bị trễ**, nhưng terminal MT5 master đã có giá realtime của broker. EA master gửi nến M1 đã đóng mỗi phút (và tick đã gộp mỗi 1 s nếu bật) cho `XAUUSD/USOIL/UKOIL` → lưu bảng `bars_m1`, các khung lớn hơn tổng hợp từ M1 (đã có `series.js`). Đồng thời đó cũng là giá dùng để đo phản ứng sau tin.

### 4.2 Cache

- `/api/bars?symbol&tf&to` trên Vercel: lịch sử đã đóng → `Cache-Control: s-maxage=60, stale-while-revalidate=600`.
- Nến M1 broker giữ 90 ngày trong Postgres, cũ hơn thì nén thành H1 (`pg_cron` hàng đêm).

### 4.3 Lưu trạng thái người dùng

Bảng `watchlists`, `layouts` (JSON layout + chỉ báo), `drawings` (theo symbol), `alerts` (dùng nguyên format rule JSON hiện tại). Alert đánh giá phía server bằng job `alerts-eval` mỗi 1 phút → gửi Web Push / Telegram.

---

## 5. Phân hệ Tin tức tác động (Vàng / BTC / Dầu)

### 5.1 Nguồn tin (giai đoạn 1 — miễn phí/công khai)

| Nhóm | Ví dụ nguồn | Tài sản chính |
|---|---|---|
| Vĩ mô Mỹ | Fed (thông cáo, lịch phát biểu – RSS), BLS (CPI, NFP), BEA (PCE, GDP), Bộ Tài chính | Vàng, BTC |
| Lịch kinh tế | Forex Factory weekly feed (đã có), Trading Economics (có key) | Cả ba |
| Năng lượng | EIA (Weekly Petroleum Status — thứ Tư), OPEC (thông cáo), Baker Hughes rig count | Dầu |
| Crypto | RSS CoinDesk, The Block, Cointelegraph; SEC press releases; dòng tiền ETF BTC | BTC |
| Kim loại quý | Kitco RSS, World Gold Council, dữ liệu vàng của các NHTW | Vàng |
| Địa chính trị | RSS tổng hợp của các hãng tin lớn (Reuters/AP/AFP nếu có giấy phép), GDELT | Vàng, Dầu |

Danh sách nguồn lưu trong bảng `news_sources` (bật/tắt, chu kỳ, độ tin cậy) để thêm bớt không cần deploy. Chỉ lưu **tiêu đề, tóm tắt ngắn, link gốc** — không chép toàn văn bài báo (bản quyền).

### 5.2 Pipeline

```
pg_cron (*/3 phút) ─► news-ingest
   1. Lấy RSS/JSON các nguồn đến hạn (ETag/If-Modified-Since)
   2. Chuẩn hóa: title, summary, url, published_at, source
   3. Chống trùng: hash(url chuẩn hóa) + hash(title chuẩn hóa) — UNIQUE
   4. Lọc sơ bộ bằng từ khóa (gold, Fed, CPI, OPEC, crude, bitcoin, ETF, tariff, war…)
      → bỏ ~70 % tin không liên quan, giảm chi phí LLM
   5. INSERT news_items (status = 'pending')

Trigger / pg_cron (*/1 phút) ─► news-score
   6. Lấy lô ≤ 20 tin pending, gọi Claude Haiku 5.5 với prompt cố định, ép JSON:
      { assets: [{asset:'XAU'|'BTC'|'WTI', impact:1..5, direction:'up'|'down'|'mixed',
                  confidence:0..1, horizon:'intraday'|'days'|'weeks'}],
        category:'monetary'|'inflation'|'jobs'|'geopolitics'|'supply'|'regulation'|'flows'|'other',
        reason_vi:'≤ 2 câu tiếng Việt' }
   7. Kiểm tra schema; lỗi → retry 2 lần → status = 'error'
   8. INSERT news_impacts; UPDATE news_items.status = 'scored'
   9. impact ≥ 4 → notify (Telegram/Discord/Web Push) + Realtime

pg_cron (*/5 phút) ─► price-reaction
  10. Với tin đã chấm 5 phút / 15 phút / 1 giờ trước: lấy giá tại t0 và t+Δ từ bars_m1
      → lưu % thay đổi và biến động so với ATR → news_price_reactions
  11. Tuần một lần: thống kê “điểm LLM” vs “phản ứng thực” theo category
      → hiệu chỉnh trọng số, phát hiện nguồn nhiễu
```

**Điểm tác động hiển thị** = `impact_llm × trọng số nguồn × hệ số category`, có badge “đã kiểm chứng” khi phản ứng thực vượt 1×ATR(14, M5).

**Lịch kinh tế**: job `econ-calendar` mỗi 1 phút trong cửa sổ ±10 phút quanh giờ ra tin (ngoài cửa sổ: 1 giờ/lần) để cập nhật actual, tính `surprise = (actual − forecast)/độ lệch chuẩn lịch sử`. Mỗi sự kiện có ánh xạ tĩnh tới tài sản (vd. CPI → XAU hướng ngược surprise, BTC hướng ngược; EIA crude inventory → WTI hướng ngược).

### 5.3 Giao diện

- Trang **Tin tức**: 3 cột Vàng / BTC / Dầu, lọc theo mức tác động, thời gian; thanh “Sắp diễn ra” cho lịch kinh tế 24 h tới.
- Trên biểu đồ: marker theo thời điểm tin (màu theo hướng, kích thước theo impact), hover xem lý do.
- “Bản tin sáng” tự động 07:00 (giờ VN): tóm tắt 5 tin lớn nhất 24 h cho từng tài sản.

### 5.4 Chi phí LLM ước tính

~3.000 tin/ngày × 30 % qua lọc ≈ 900 lần gọi × ~600 token vào + 150 token ra. Với Haiku, cỡ vài USD/ngày trở xuống; gom lô 10–20 tin/lần gọi và dùng prompt caching cho phần hướng dẫn cố định để giảm thêm. Đặt hạn mức ngày trong `app_settings`, vượt hạn mức thì chỉ chấm tin đã qua lọc mức cao.

---

## 6. Phân hệ Copy Trade MT5

### 6.1 Nguyên tắc thiết kế

1. **Không giữ mật khẩu MT5.** Chủ tài khoản tự đăng nhập terminal và gắn EA; hệ thống chỉ cấp **token EA** (chuỗi ngẫu nhiên 32 byte, lưu dạng băm SHA-256).
2. **Luồng sự kiện có số thứ tự (`seq`)** tăng dần theo từng master → receiver luôn biết mình đã xử lý tới đâu, mất mạng thì kéo lại phần thiếu.
3. **Idempotent hai đầu:** server bỏ qua sự kiện trùng `(master_id, event_uid)`; receiver đánh dấu lệnh bằng `magic` + `comment = "QT#<master_ticket>"` nên không bao giờ mở trùng.
4. **Receiver tự quyết định rủi ro cuối cùng**: mọi giới hạn được kiểm tra trong EA receiver ngay trước khi gửi lệnh (server có thể chậm hoặc mất kết nối).
5. **Đối soát định kỳ** là lưới an toàn cho mọi lỗi còn lại.

### 6.2 Luồng một lệnh

```
MASTER EA                         SUPABASE                                RECEIVER EA (×N)
─────────                         ────────                                ────────────────
OnTradeTransaction()
  DEAL_ADD / ORDER / POSITION
  → dựng event JSON
  → POST /ct-ingest  ───────────► xác thực token + HMAC + timestamp
     (retry, hàng đợi              chèn ct_events (seq = nextval theo master)
      cục bộ nếu mất mạng)         ON CONFLICT (event_uid) DO NOTHING
                       ◄─ 200 {seq}  NOTIFY / Realtime broadcast ─────┐
                                                                     ▼
                                   /ct-pull?since=<last_seq>   ◄──── long-poll (giữ ≤ 20 s,
                                   trả ngay khi có event mới  ────►   trả ngay khi có event)
                                                                     │
                                                                     ▼
                                                           kiểm tra: link bật? symbol cho phép?
                                                           event quá cũ (> max_age_s)? giờ giao dịch?
                                                           tính lot theo lot_mode, ánh xạ symbol
                                                           kiểm tra trượt giá ≤ max_slippage_pts
                                                           kiểm tra max lot, max lệnh, DD ngày
                                                           OrderSend / PositionModify / Close
                                   /ct-ack  ◄───────────────────── {seq, status, receiver_ticket,
                                   ghi ct_executions,              fill_price, slippage, latency_ms,
                                   cập nhật ct_position_map         error_code}
                                   Realtime → dashboard
```

### 6.3 Loại sự kiện

| `type` | Nguồn trên master | Xử lý ở receiver |
|---|---|---|
| `OPEN` | Deal IN của position mới | Mở lệnh market cùng hướng (hoặc đảo nếu `reverse`) |
| `CLOSE` | Deal OUT đóng hết | Đóng position có `comment = QT#ticket` |
| `PARTIAL_CLOSE` | Deal OUT một phần | Đóng cùng **tỷ lệ** khối lượng đã đóng của master |
| `MODIFY` | Thay đổi SL/TP | Sửa SL/TP (theo giá tuyệt đối hoặc theo khoảng cách points — cấu hình) |
| `PENDING_PLACE / MODIFY / DELETE` | Lệnh chờ | Tùy chọn `copy_pending` |
| `SNAPSHOT` | Mỗi 30 s | Danh sách position đang mở của master, dùng để đối soát |

Ví dụ payload:

```json
{
  "event_uid": "8812345-DEAL-90011223",
  "type": "OPEN",
  "master_ticket": 90011223,
  "symbol": "XAUUSD",
  "side": "BUY",
  "volume": 0.50,
  "price": 2650.35,
  "sl": 2640.00,
  "tp": 2670.00,
  "master_balance": 10000.00,
  "master_equity": 10120.50,
  "ts_ms": 1794567890123
}
```

Header: `X-QT-Account: <account_id>`, `X-QT-Timestamp`, `X-QT-Signature: HMAC_SHA256(secret, timestamp + body)`. Server từ chối nếu lệch giờ > 30 s (chống phát lại).

### 6.4 Cách tính khối lượng (`lot_mode`)

| Chế độ | Công thức | Dùng khi |
|---|---|---|
| `fixed` | `lot = fixed_lot` | Thử nghiệm |
| `multiplier` | `lot = master_lot × k` | Cùng quy mô vốn |
| `equity_ratio` | `lot = master_lot × (equity_receiver / equity_master) × k` | **Mặc định**, tự co giãn theo vốn |
| `risk_percent` | `lot` sao cho khoảng SL = `risk_% × equity` | Master luôn đặt SL |

Sau đó: làm tròn theo `SYMBOL_VOLUME_STEP`, kẹp trong `[VOLUME_MIN, min(VOLUME_MAX, max_lot)]`; nếu dưới `VOLUME_MIN` thì theo cấu hình `skip` hoặc `min_lot`. Giá trị hợp đồng khác nhau giữa broker (vàng 100 oz/lot vs 1 oz/lot…) xử lý bằng `contract_size` đọc trực tiếp trong EA (`SYMBOL_TRADE_CONTRACT_SIZE`) và quy đổi.

### 6.5 Ánh xạ symbol

`symbol_map` JSON theo từng link: `{"XAUUSD":"XAUUSDm","USOIL":"WTI.cash","BTCUSD":"BTCUSD#"}`. Mặc định EA thử tự khớp theo tiền tố/hậu tố phổ biến (`m`, `.r`, `#`, `pro`), không khớp được thì bỏ qua và báo lỗi `SYMBOL_NOT_FOUND` lên dashboard.

### 6.6 Bảo vệ rủi ro trên receiver

`max_lot_per_trade`, `max_open_positions`, `max_daily_loss_pct` (vượt → tự tạm dừng link), `max_slippage_points`, `max_signal_age_s` (mặc định 10 s — tin cũ không vào lệnh mới, nhưng **vẫn** thực hiện CLOSE), `allowed_symbols`, `trading_hours`, `copy_sl_tp`, `reverse`. Nút **Emergency stop** ghi `copy_links.enabled = false` + sự kiện `KILL` (tùy chọn `close_all`) — receiver nhận trong lần poll kế tiếp; ngoài ra EA tự dừng nếu không liên lạc được server > `offline_halt_s` (chỉ dừng mở mới, vẫn giữ SL/TP).

### 6.7 Đối soát (`ct-reconcile`)

Mỗi 30 s receiver gửi heartbeat kèm danh sách position có tag `QT#`. Server so với `SNAPSHOT` mới nhất của master:

| Tình huống | Hành động |
|---|---|
| Master đã đóng, receiver còn mở (“mồ côi”) | Tạo lệnh `CLOSE` cho riêng receiver đó |
| Master đang mở, receiver chưa có, tín hiệu còn mới | Mở bù (nếu `catch_up = true` và giá chưa đi quá `max_slippage_points`) |
| Lệch khối lượng | Ghi cảnh báo, không tự sửa |
| Receiver mất heartbeat > 90 s | Đánh dấu `offline`, cảnh báo Telegram cho quản trị |

### 6.8 Vì sao chọn long-poll HTTP thay vì WebSocket / dịch vụ ngoài

| Phương án | Ưu | Nhược | Kết luận |
|---|---|---|---|
| **A. EA ↔ Edge Function long-poll** | Đúng stack Supabase, MQL5 làm được bằng `WebRequest`, không lưu mật khẩu | Trễ ~200–800 ms, mỗi lần poll là 1 invocation | **Chọn cho giai đoạn 1** |
| B. EA poll PostgREST/RPC trực tiếp mỗi 300 ms | Đơn giản, không tốn invocation Edge | Tải DB cao khi nhiều receiver, trễ phụ thuộc chu kỳ | Phương án dự phòng |
| C. WebSocket bằng `SocketCreate` trong MQL5 tới Supabase Realtime | Trễ thấp nhất | Tự cài giao thức WS + Phoenix trong MQL5, khó bảo trì | Giai đoạn 3 nếu cần < 200 ms |
| D. Dịch vụ cloud MT5 bên thứ ba (vd. MetaApi) | Không cần VPS, không cần EA | Phải giao mật khẩu đầu tư/giao dịch cho bên thứ ba, phí theo tài khoản | Không chọn (rủi ro bảo mật) |
| E. Copier cục bộ trên cùng VPS (file chung / named pipe) | Trễ < 50 ms | Chỉ dùng khi master và receiver cùng máy | Chế độ bổ sung cho VPS nội bộ |

Lưu lượng ước tính phương án A: 50 receiver × (1 poll / 20 s khi rảnh) + heartbeat 30 s ≈ 4–5 request/s, ≈ 12 triệu/tháng ở mức tối đa — cần theo dõi hạn mức invocation của gói Supabase; nếu vượt, chuyển phần pull sang phương án B (RPC `ct_pull`) không đổi EA nhiều.

### 6.9 Khung mã EA (rút gọn)

```mql5
// QT_MasterSender.mq5
input string InpApiUrl  = "https://<project>.supabase.co/functions/v1";
input string InpToken   = "";          // token EA lấy từ dashboard
input string InpSecret  = "";          // khóa HMAC

void OnTradeTransaction(const MqlTradeTransaction &t, const MqlTradeRequest &r, const MqlTradeResult &res)
{
   if(t.type == TRADE_TRANSACTION_DEAL_ADD)      QueueDealEvent(t.deal);     // OPEN/CLOSE/PARTIAL
   else if(t.type == TRADE_TRANSACTION_POSITION) QueueModifyEvent(t.position); // SL/TP
   else if(t.type == TRADE_TRANSACTION_ORDER_ADD || t.type == TRADE_TRANSACTION_ORDER_DELETE)
                                                 QueuePendingEvent(t.order);
   FlushQueue();                    // POST /ct-ingest, giữ lại trong file nếu lỗi mạng
}
void OnTimer() { FlushQueue(); SendSnapshotEvery(30); SendBarsM1(); }
```

```mql5
// QT_Receiver.mq5
void OnTimer()   // EventSetMillisecondTimer(250)
{
   string body;
   if(!LongPoll(InpApiUrl + "/ct-pull?since=" + IntegerToString(g_lastSeq), body)) return;
   CEvent ev[]; ParseEvents(body, ev);
   for(int i = 0; i < ArraySize(ev); i++)
   {
      ExecResult r = Apply(ev[i]);    // risk checks + OrderSend/Modify/Close, magic + "QT#ticket"
      Ack(ev[i].seq, r);
      g_lastSeq = ev[i].seq;  SaveSeq(g_lastSeq);   // GlobalVariableSet để sống sót khi restart
   }
}
```

Lưu ý vận hành: `WebRequest` chặn luồng của EA → receiver chạy trên **một chart riêng**, mỗi terminal một tài khoản; thêm URL Supabase vào *Tools → Options → Expert Advisors → Allow WebRequest*.

---

## 7. Mô hình dữ liệu (Supabase)

```sql
-- ===== Người dùng & phân quyền =====
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text, role text not null default 'user' check (role in ('admin','manager','user')),
  telegram_chat_id text, created_at timestamptz default now()
);

-- ===== Biểu đồ =====
create table watchlists (id uuid primary key default gen_random_uuid(), user_id uuid references profiles, name text, symbols text[]);
create table layouts    (id uuid primary key default gen_random_uuid(), user_id uuid references profiles, name text, state jsonb, updated_at timestamptz default now());
create table drawings   (id uuid primary key default gen_random_uuid(), user_id uuid references profiles, symbol text, data jsonb);
create table alerts     (id uuid primary key default gen_random_uuid(), user_id uuid references profiles, rule jsonb, channels text[], active bool default true, last_fired_at timestamptz);
create table bars_m1 (
  symbol text, ts timestamptz, o numeric, h numeric, l numeric, c numeric, v numeric, source text,
  primary key (symbol, ts)
);

-- ===== Tin tức =====
create table news_sources (id serial primary key, name text, url text, kind text check (kind in ('rss','json','html')),
  assets text[], weight numeric default 1, interval_min int default 5, enabled bool default true, etag text, last_fetched_at timestamptz);
create table news_items (
  id bigserial primary key, source_id int references news_sources, url text not null, url_hash text unique,
  title text not null, title_hash text, summary text, published_at timestamptz, fetched_at timestamptz default now(),
  status text default 'pending' check (status in ('pending','filtered','scored','error')),
  category text, reason_vi text
);
create table news_impacts (
  news_id bigint references news_items on delete cascade, asset text check (asset in ('XAU','BTC','WTI','BRENT')),
  impact smallint check (impact between 1 and 5), direction text, confidence numeric, horizon text,
  primary key (news_id, asset)
);
create table econ_events (id bigserial primary key, country text, title text, scheduled_at timestamptz, importance smallint,
  forecast numeric, previous numeric, actual numeric, surprise numeric, assets text[], unique (country, title, scheduled_at));
create table news_price_reactions (news_id bigint references news_items, asset text, window_min int,
  pct_change numeric, atr_multiple numeric, primary key (news_id, asset, window_min));
create index on news_items (published_at desc);
create index on news_impacts (asset, impact desc);

-- ===== Copy trade =====
create table mt5_accounts (
  id uuid primary key default gen_random_uuid(), owner_id uuid references profiles,
  role text not null check (role in ('master','receiver')),
  label text, broker text, server text, login bigint, currency text,
  token_hash text not null unique, hmac_secret_enc text,          -- mã hóa bằng Supabase Vault
  status text default 'offline', last_heartbeat_at timestamptz, balance numeric, equity numeric,
  ea_version text, created_at timestamptz default now(), unique (server, login)
);
create table copy_links (
  id uuid primary key default gen_random_uuid(),
  master_id uuid references mt5_accounts, receiver_id uuid references mt5_accounts,
  enabled bool default false,
  lot_mode text default 'equity_ratio' check (lot_mode in ('fixed','multiplier','equity_ratio','risk_percent')),
  lot_value numeric default 1, symbol_map jsonb default '{}', allowed_symbols text[],
  reverse bool default false, copy_sl_tp bool default true, copy_pending bool default false,
  max_lot numeric, max_open_positions int, max_daily_loss_pct numeric, max_slippage_points int default 50,
  max_signal_age_s int default 10, catch_up bool default false, trading_hours jsonb,
  unique (master_id, receiver_id)
);
create table ct_events (
  master_id uuid references mt5_accounts, seq bigint, event_uid text, type text, payload jsonb,
  master_ts timestamptz, received_at timestamptz default now(),
  primary key (master_id, seq), unique (master_id, event_uid)
);
create table ct_executions (
  id bigserial primary key, link_id uuid references copy_links, master_id uuid, seq bigint,
  status text check (status in ('done','skipped','failed')), reason text, error_code int,
  receiver_ticket bigint, volume numeric, fill_price numeric, slippage_points numeric, latency_ms int,
  created_at timestamptz default now(), unique (link_id, seq)
);
create table ct_position_map (link_id uuid references copy_links, master_ticket bigint, receiver_ticket bigint,
  symbol text, volume numeric, opened_at timestamptz, closed_at timestamptz, primary key (link_id, master_ticket));
create table audit_log (id bigserial primary key, actor uuid, action text, target text, detail jsonb, at timestamptz default now());
```

- **Cấp `seq`**: hàm `ct_next_seq(master_id)` dùng bảng đếm + `UPDATE … RETURNING` trong cùng giao dịch insert, bảo đảm tăng dần không trùng.
- **RLS**: người dùng chỉ thấy `mt5_accounts`/`copy_links`/`ct_*` của mình; `admin/manager` thấy tất cả; bảng `ct_events` chỉ được ghi bởi Edge Function (service role). Tin tức đọc công khai.
- **Giữ dữ liệu**: `ct_events` 90 ngày, `ct_executions` 2 năm (phục vụ đối chiếu, tranh chấp), `news_items` vĩnh viễn (nhẹ).
- **Realtime** bật cho: `news_items` (status = scored), `mt5_accounts` (status/equity), `ct_executions`.

---

## 8. API cho EA (Edge Functions)

| Endpoint | Vai | Mô tả |
|---|---|---|
| `POST /ct-ingest` | Master | Nhận 1..n event; trả `{accepted:[{event_uid, seq}]}` |
| `GET /ct-pull?since=N&wait=20` | Receiver | Long-poll; trả các event `seq > N` của master đã link + lệnh `KILL`/`CLOSE` do đối soát, kèm cấu hình link hiện hành (EA cache lại) |
| `POST /ct-ack` | Receiver | Kết quả thực thi từng `seq` |
| `POST /ct-heartbeat` | Cả hai | balance, equity, margin, danh sách position `QT#`, phiên bản EA, ping |
| `POST /bars-push` | Master | Nến M1 XAU/Oil từ broker |

Mã lỗi thống nhất: `401 TOKEN_INVALID`, `403 LINK_DISABLED`, `409 DUPLICATE`, `426 EA_OUTDATED` (ép cập nhật EA), `429 RATE_LIMIT`.

---

## 9. Giao diện chính (Next.js)

| Route | Nội dung |
|---|---|
| `/chart/[symbol]` | Terminal biểu đồ (port từ app hiện tại), marker tin tức |
| `/news` | Bảng tin 3 tài sản, lịch kinh tế, bộ lọc tác động |
| `/copy` | Tổng quan: master, receiver, online/offline, P&L hôm nay, độ trễ p95 |
| `/copy/accounts/new` | Thêm tài khoản MT5 → hiện token + hướng dẫn cài EA + nút tải `.ex5` |
| `/copy/links/[id]` | Cấu hình lot, symbol map, rủi ro; lịch sử thực thi; nút dừng khẩn cấp |
| `/copy/logs` | Log sự kiện / lỗi, lọc theo receiver |
| `/admin` | Người dùng, nguồn tin, hạn mức LLM, phát hành phiên bản EA |

---

## 10. Cấu trúc mã nguồn (GitHub monorepo)

```
quant-terminal-cloud/
├─ apps/web/                 # Next.js → Vercel
├─ packages/core/            # indicators, series, backtest, quant (từ public/lib) + test
├─ packages/shared/          # type TS chung: event copy trade, schema tin tức (zod)
├─ supabase/
│  ├─ migrations/            # SQL ở mục 7, chia nhỏ theo thời gian
│  ├─ functions/             # news-ingest, news-score, econ-calendar, price-reaction,
│  │                         # alerts-eval, notify, ct-ingest, ct-pull, ct-ack, ct-heartbeat, ct-reconcile
│  └─ seed.sql               # nguồn tin mặc định, tài khoản demo
├─ mql5/
│  ├─ Experts/QT_MasterSender.mq5
│  ├─ Experts/QT_Receiver.mq5
│  └─ Include/QT/            # Http.mqh, Json.mqh, Hmac.mqh, Risk.mqh
├─ legacy/                   # bản Quant Terminal cục bộ hiện tại (giữ chạy song song)
└─ .github/workflows/
   ├─ ci.yml                 # lint, typecheck, test core, test Edge Functions (deno test)
   ├─ db.yml                 # supabase db push + functions deploy khi merge main
   └─ ea.yml                 # (tuỳ chọn) biên dịch MQL5 bằng MetaEditor trên runner Windows
```

### CI/CD

- **PR**: GitHub Actions chạy test → Vercel tạo Preview → Supabase Branching tạo DB nhánh chạy migration.
- **Merge `main`**: `supabase db push` + `supabase functions deploy` → Vercel Production tự deploy.
- Bí mật: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN` trong GitHub Secrets / Supabase Secrets / Vercel Env — **không** commit.
- Branch protection trên `main`: bắt buộc review + CI xanh. Thay đổi trong `supabase/functions/ct-*` và `mql5/` cần 2 người duyệt (ảnh hưởng tiền thật).

---

## 11. Bảo mật & tuân thủ

- Token EA chỉ hiện **một lần** khi tạo; có thể thu hồi/cấp lại. Băm SHA-256 khi lưu, secret HMAC lưu trong Supabase Vault.
- Rate limit theo token (bảng đếm theo phút hoặc Upstash Redis nếu cần).
- Toàn bộ thao tác thay đổi cấu hình copy và nút dừng khẩn cấp ghi `audit_log`.
- Bật MFA cho tài khoản `admin/manager`.
- **Pháp lý:** quản lý/sao chép lệnh cho tài khoản của người khác, đặc biệt khi có thu phí, có thể thuộc diện phải cấp phép tùy quốc gia và có thể vi phạm điều khoản của broker. Cần bộ phận pháp chế xác nhận mô hình kinh doanh trước khi mở cho khách hàng bên ngoài. Giai đoạn đầu chỉ dùng cho tài khoản nội bộ / chính chủ.
- Hiển thị tuyên bố: điểm tác động tin tức là phân tích tự động, không phải khuyến nghị đầu tư.

---

## 12. Giám sát & vận hành

| Chỉ số | Ngưỡng cảnh báo |
|---|---|
| Độ trễ copy p95 (`ct_executions.latency_ms`) | > 1.500 ms trong 5 phút |
| Tỷ lệ `failed` | > 2 % trong 1 giờ |
| Receiver offline | > 90 s |
| Master không gửi heartbeat | > 60 s → cảnh báo khẩn |
| Lệnh mồ côi phát hiện bởi đối soát | ≥ 1 |
| Job tin tức thất bại liên tiếp | ≥ 3 |
| Chi phí LLM ngày | > 80 % hạn mức |

Cảnh báo gửi Telegram nhóm vận hành. Có trang `/admin/health` đọc từ view tổng hợp. Runbook xử lý: master mất kết nối, broker từ chối lệnh (`TRADE_RETCODE_*`), lệch giờ server, cập nhật EA.

---

## 13. Lộ trình triển khai

| Giai đoạn | Thời gian | Kết quả |
|---|---|---|
| **0. Nền móng** | Tuần 1–2 | Monorepo, Supabase project, Auth, CI/CD, `packages/core` + test xanh |
| **1. Biểu đồ cloud** | Tuần 3–5 | Port chart vào Next.js, watchlist/layout/drawing lưu Supabase, `/api/bars` |
| **2. Tin tức** | Tuần 5–8 | Thu tin, chấm điểm LLM, lịch kinh tế, trang `/news`, marker trên chart, cảnh báo Telegram |
| **3. Copy trade MVP** | Tuần 6–10 | EA master/receiver, ingest/pull/ack, OPEN/CLOSE/MODIFY, `equity_ratio`, dashboard, emergency stop |
| **4. Cứng hóa copy** | Tuần 10–12 | Partial close, pending, đối soát, giới hạn rủi ro đầy đủ, nến broker M1, đo phản ứng giá |
| **5. Thử nghiệm thực** | Tuần 12–14 | Chạy **tài khoản demo** 2 tuần (≥ 500 lệnh, đo trễ/trượt giá), sau đó tài khoản thật vốn nhỏ |
| **6. Mở rộng** | Sau đó | WebSocket MQL5, nhiều master/chiến lược, báo cáo hiệu suất, app di động (PWA) |

Nhân sự tối thiểu: 1 fullstack (Next.js + Supabase), 1 lập trình MQL5, 0,5 QA/vận hành.

### Tiêu chí nghiệm thu copy trade (trên demo)

- 0 lệnh bị nhân đôi, 0 lệnh mồ côi tồn tại quá 60 s sau 500 lệnh thử.
- Rút dây mạng receiver 5 phút rồi cắm lại → tự đồng bộ đúng trạng thái master.
- Khởi động lại terminal giữa chừng → không mở lại lệnh đã copy.
- Emergency stop có hiệu lực ở mọi receiver online trong ≤ 25 s.

---

## 14. Rủi ro & điểm cần xem lại khi tăng quy mô

| Rủi ro | Giảm thiểu |
|---|---|
| Hạn mức invocation Edge Function khi nhiều receiver | Chuyển pull sang RPC PostgREST hoặc relay WebSocket riêng |
| Độ trễ không đạt yêu cầu scalping | Đặt Supabase cùng vùng với VPS MT5 (vd. Singapore), chế độ copier cục bộ, WebSocket MQL5 |
| Broker khác nhau về symbol / contract size / số chữ số | Ánh xạ symbol + đọc thuộc tính symbol trong EA, test với từng broker |
| LLM chấm sai/thiên lệch | Kiểm chứng bằng phản ứng giá, hiệu chỉnh trọng số, cho admin sửa tay |
| Nguồn tin thay đổi định dạng / chặn | Mỗi nguồn một adapter có test, cảnh báo khi 0 tin trong 1 giờ |
| Rủi ro pháp lý khi phục vụ khách hàng ngoài | Xin ý kiến pháp chế trước giai đoạn 6 |

---

## 15. Quyết định cần chủ dự án xác nhận

1. Copy trade chỉ cho **tài khoản nội bộ/chính chủ** hay sẽ cung cấp dịch vụ cho khách hàng (ảnh hưởng pháp lý, phân quyền, tính phí)?
2. Phong cách giao dịch của master (scalping vs swing) → quyết định có cần đầu tư phương án độ trễ thấp ngay từ đầu không.
3. Các broker sử dụng cho master và receiver (để chuẩn bị bảng ánh xạ symbol).
4. Có ngân sách cho nguồn tin/giá trả phí (Trading Economics, Polygon, giấy phép hãng tin) hay chỉ dùng nguồn miễn phí ở giai đoạn đầu?
5. Vùng triển khai Supabase (khuyến nghị Singapore nếu VPS MT5 đặt ở châu Á).
