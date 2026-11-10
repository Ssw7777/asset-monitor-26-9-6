/**
 * 全站记账单位统一为 USDT（与 USD 1:1，不做汇率换算）。
 * 显示为 `1,234.56 USDT`，不用 $ 符号，也不换算成 USD。
 */
export function usd(n: number) {
  const value = Number(n) || 0;
  return `${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} USDT`;
}

export function cny(n: number) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n || 0);
}

export function shortAddr(a: string) {
  if (!a || a.length < 10) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function timeAgo(iso: string | null) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** 大额缩写，和交易所/DeBank 一样的 $12.56K / $1.23M 表达。 */
export function usdCompact(n: number) {
  const value = Number(n) || 0;
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B USDT`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M USDT`;
  if (abs >= 10_000) return `${(value / 1000).toFixed(2)}K USDT`;
  return usd(value);
}

/** 代币价格：低价币保留更多小数位，避免显示成 $0.00。 */
export function priceUsd(n: number) {
  const value = Number(n) || 0;
  if (value === 0) return "0";
  if (Math.abs(value) < 0.000001) return value.toExponential(2);
  if (Math.abs(value) < 0.01) return value.toFixed(6);
  if (Math.abs(value) < 1) return value.toFixed(4);
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 代币数量：整数部分分组，小数位自适应。 */
export function amountNum(n: number) {
  const value = Number(n) || 0;
  if (Math.abs(value) >= 1000) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  if (Math.abs(value) >= 1) return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  if (value === 0) return "0";
  return value.toPrecision(4);
}

export function signedUsd(n: number) {
  return `${n > 0 ? "+" : n < 0 ? "-" : ""}${usd(Math.abs(n))}`;
}

export function signedPct(n: number | null) {
  if (n == null) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

export function deltaClass(n: number) {
  if (n > 0) return "pos";
  if (n < 0) return "neg";
  return "flat";
}
