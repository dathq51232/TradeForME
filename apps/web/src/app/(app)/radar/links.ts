// Trade pages on each exchange, so a coin the radar shows opens where it can be traded (the user places the
// order there; the radar never does). Spot pages from the coin and quote; perpetuals from the contract's own symbol.

/** The spot trading page of base/quote on an exchange, or null for an exchange without one here. */
export function spotUrl(ex: string, base: string, quote: string): string | null {
  const b = base.toUpperCase(), q = quote.toUpperCase();
  switch (ex) {
    case "BINANCE": return `https://www.binance.com/en/trade/${b}_${q}?type=spot`;
    case "OKX": return `https://www.okx.com/trade-spot/${b.toLowerCase()}-${q.toLowerCase()}`;
    case "BYBIT": return `https://www.bybit.com/en/trade/spot/${b}/${q}`;
    case "KUCOIN": return `https://www.kucoin.com/trade/${b}-${q}`;
    case "GATE": return `https://www.gate.com/trade/${b}_${q}`;
    case "KRAKEN": return `https://pro.kraken.com/app/trade/${b.toLowerCase()}-${q.toLowerCase()}`;
    case "COINBASE": return `https://www.coinbase.com/advanced-trade/spot/${b}-${q}`;
    default: return null;
  }
}

/** The perpetual's trading page, from the contract symbol the exchange uses (1000PEPEUSDT, PEPE-USDT-SWAP, XBTUSDTM…). */
export function perpUrl(ex: string, native: string): string | null {
  switch (ex) {
    case "BINANCE": return `https://www.binance.com/en/futures/${native}`;
    case "BYBIT": return `https://www.bybit.com/trade/usdt/${native}`;
    case "OKX": return `https://www.okx.com/trade-swap/${native.toLowerCase()}`;
    case "GATE": return `https://www.gate.com/futures/USDT/${native}`;
    case "KUCOIN": return `https://www.kucoin.com/trade/futures/${native}`;
    default: return null;
  }
}
