import { Suspense } from "react";
import { SYMBOLS } from "@qt/shared/market";
import { PageHeader } from "@/components/ui";
import { BacktestView } from "./backtest-view";

// Backtest: how often the chart's automatic readings come true, and a strategy tester for indicator rules.
// Market data is public and both run in the browser, so the page is open to everyone like the charts.
export default function BacktestPage(props: PageProps<"/backtest">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Đang tải…</p>}>
      <Backtest searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Backtest({ searchParams }: { searchParams: PageProps<"/backtest">["searchParams"] }) {
  const sp = await searchParams;
  const want = typeof sp.symbol === "string" ? sp.symbol.toUpperCase() : "";
  return (
    <>
      <PageHeader title="Backtest"
        sub="Đo độ chính xác của phần tự nhận diện (Elliott, nêm nhỏ, mô hình giá) và chạy thử chiến lược chỉ báo trên dữ liệu quá khứ. Chỉ để đánh giá, không phải khuyến nghị." />
      <BacktestView initialSymbol={SYMBOLS[want] ? want : "XAUUSD"} />
    </>
  );
}
