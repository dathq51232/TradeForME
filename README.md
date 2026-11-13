# Quant Terminal Cloud

Biểu đồ kiểu TradingView, tin tức tác động **Vàng / BTC / Dầu**, quản lý **copy trade MT5** (1 master → nhiều receiver).
Stack: **Supabase** (Postgres, Auth, Realtime, Edge Functions) · **Vercel** (Next.js) · **GitHub** (CI/CD).

Thiết kế đầy đủ: [docs/THIET-KE-HE-THONG.md](docs/THIET-KE-HE-THONG.md). Dựa trên Quant Terminal (MIT), xem `LICENSE`, `NOTICE`.

## Cấu trúc

```
apps/web/            Next.js 16 (App Router) → Vercel. Đăng nhập Supabase, dashboard
packages/core/       Chỉ báo, resample, backtest, quant checks (JS thuần, 140 test)
packages/shared/     Schema sự kiện copy trade, quy tắc tính lot/ánh xạ symbol, schema chấm tin (zod)
supabase/
  migrations/        Schema + RLS + RPC (create_mt5_account, ct_append_events, ct_pull…)
  functions/health/  Edge Function kiểm tra sống
  tests/smoke.sql    Kiểm tra RLS và RPC copy trade (chạy trong CI)
  seed.sql           Nguồn tin mặc định
mql5/                EA Master/Receiver (Giai đoạn 3)
.github/workflows/   ci.yml (mọi PR), deploy-supabase.yml (merge main)
```

## Chạy cục bộ

```bash
npm install
```

```bash
npm test
```

```bash
cp apps/web/.env.example apps/web/.env.local
```

Điền URL và publishable key của Supabase vào `apps/web/.env.local`, rồi:

```bash
npm run dev
```

Mở http://localhost:3000. Muốn chạy Supabase cục bộ (cần Docker): `npx supabase start`, rồi lấy URL/key mà lệnh in ra.

## Thiết lập lần đầu (làm một lần)

**1. Supabase**
1. Tạo project (khuyến nghị vùng Singapore nếu VPS MT5 ở châu Á).
2. Authentication → URL Configuration: Site URL = domain Vercel; Redirect URLs thêm `https://<domain>/auth/callback` và `https://*-<team>.vercel.app/auth/callback` (preview).
3. Lấy `Project ref`, `Publishable key`, mật khẩu DB.

**2. GitHub**
1. Tạo repo, push mã này lên nhánh `main`.
2. Settings → Secrets and variables → Actions: `SUPABASE_ACCESS_TOKEN` (từ supabase.com/dashboard/account/tokens), `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_ID`.
3. Settings → Environments → `production`: thêm người duyệt bắt buộc (migration chạm DB thật).
4. Settings → Branches: bảo vệ `main`, bắt buộc CI xanh + review.

**3. Vercel**
1. Import repo GitHub, **Root Directory = `apps/web`** (Vercel tự nhận npm workspaces).
2. Environment Variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (Production + Preview).
3. Kiểm tra: `https://<domain>/api/health` trả `"supabase":"configured"`.

**4. Cấp quyền admin cho chính mình** (SQL Editor của Supabase, sau khi đăng ký tài khoản trên web):

```sql
update public.profiles set role = 'admin' where id = (select id from auth.users where email = '<email của bạn>');
```

## Luồng phát hành

PR → CI (test, lint, typecheck, build, migration + smoke SQL trên Postgres sạch) → Vercel Preview → merge `main` → `deploy-supabase` (cần duyệt) + Vercel Production.

## Trạng thái

- [x] Giai đoạn 0 — monorepo, core + shared có test, schema + RLS, Auth, CI/CD
- [x] Nâng cấp theo tài liệu MT5 Copy Trading ([phân tích](docs/PHAN-TICH-NANG-CAP.md)): copy group, Pause/Stop/Emergency/Close All, risk limits, app shell tối, Dashboard, MT5 Accounts, Copy Trading, cấu hình Receiver
- [x] Giai đoạn 1 — biểu đồ cloud: /charts (Lightweight Charts, 7 khung TG, ~70 chỉ báo từ packages/core, đường giá, watchlist, layout lưu Supabase), /api/bars (broker M1 → Binance → Coinbase → Yahoo)
- [ ] Giai đoạn 2 — tin tức tác động
- [ ] Giai đoạn 3 — copy trade MT5

Không phải khuyến nghị đầu tư.
