import type { ManualAsset, SnapshotPoint } from "./types";

export type ManualCurrency = "USD" | "CNY";

const round2 = (n: number) => Math.round(n * 100) / 100;

export function resolveManualCurrency(raw: unknown): ManualCurrency {
  return String(raw).toUpperCase() === "CNY" ? "CNY" : "USD";
}

/** 记账本币金额（人民币条用 CNY，其余用 USDT）。 */
export function manualNativeAmount(item: Pick<ManualAsset, "currency" | "amount" | "amountUsd">): number {
  if (item.currency === "CNY") return Number(item.amount) || 0;
  if (item.amount != null && Number.isFinite(Number(item.amount))) return Number(item.amount) || 0;
  return Number(item.amountUsd) || 0;
}

/** 折合 USDT，供总额 / 快照使用。 */
export function manualToUsd(
  item: Pick<ManualAsset, "currency" | "amount" | "amountUsd">,
  usdCnyRate: number
): number {
  const rate = usdCnyRate > 0 ? usdCnyRate : 6.66;
  if (item.currency === "CNY") {
    return round2((Number(item.amount) || 0) / rate);
  }
  return round2(Number(item.amountUsd) || 0);
}

/**
 * 规范化一条手动资产。旧数据只有 amountUsd、无 currency → 视为 USDT。
 * CNY 条按当前汇率写入 amountUsd；USD 条 amount 与 amountUsd 同值。
 */
export function normalizeManualAsset(
  raw: Partial<ManualAsset> & { id?: string; name?: string },
  usdCnyRate: number
): ManualAsset {
  const currency = resolveManualCurrency(raw.currency);
  const rate = usdCnyRate > 0 ? usdCnyRate : 6.66;
  let amount: number;
  let amountUsd: number;

  if (currency === "CNY") {
    if (raw.amount != null && Number.isFinite(Number(raw.amount))) {
      amount = round2(Number(raw.amount));
      amountUsd = round2(amount / rate);
    } else {
      amountUsd = round2(Number(raw.amountUsd) || 0);
      amount = round2(amountUsd * rate);
    }
  } else {
    const v =
      raw.amount != null && Number.isFinite(Number(raw.amount))
        ? Number(raw.amount)
        : Number(raw.amountUsd) || 0;
    amount = round2(v);
    amountUsd = amount;
  }

  return {
    id: String(raw.id || `m_${Date.now()}`),
    name: String(raw.name || "未命名").slice(0, 120),
    currency,
    amount,
    amountUsd,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
  };
}

/** 汇率变更时重算 CNY 条的 amountUsd（本币金额不变）。 */
export function revalueManualForRate(items: ManualAsset[], usdCnyRate: number): ManualAsset[] {
  return items.map((item) => {
    if (item.currency !== "CNY") return item;
    return {
      ...item,
      amount: round2(Number(item.amount) || 0),
      amountUsd: manualToUsd(item, usdCnyRate),
    };
  });
}

/** 非人民币手动资产（加密 / 链上记账）才进 K 线。 */
export function isCryptoManual(item: Pick<ManualAsset, "currency">): boolean {
  return resolveManualCurrency(item.currency) !== "CNY";
}

/** 仅合计非 CNY 手动资产的 USDT，供资产趋势快照使用。 */
export function sumManualCryptoUsd(
  items: Array<Pick<ManualAsset, "currency" | "amount" | "amountUsd">>,
  usdCnyRate: number
): number {
  return round2(
    items.filter(isCryptoManual).reduce((sum, item) => sum + manualToUsd(item, usdCnyRate), 0)
  );
}

/** 人民币手动资产本币合计（¥），供 Web2 展示。 */
export function sumManualCnyNative(
  items: Array<Pick<ManualAsset, "currency" | "amount" | "amountUsd">>
): number {
  return round2(
    items
      .filter((item) => resolveManualCurrency(item.currency) === "CNY")
      .reduce((sum, item) => sum + manualNativeAmount(item), 0)
  );
}

/** 当前人民币手动资产名称（用于从历史快照里按名剔除）。 */
export function cnyManualNames(items: Array<Pick<ManualAsset, "currency" | "name">>): Set<string> {
  return new Set(
    items
      .filter((item) => resolveManualCurrency(item.currency) === "CNY")
      .map((item) => String(item.name || "").trim())
      .filter(Boolean)
  );
}

/** 从快照中按名剔除人民币手动资产，使 K 线只反映加密资产。 */
export function stripCnyManualFromSnapshot(
  point: SnapshotPoint,
  cnyNames: Set<string>
): SnapshotPoint {
  if (!cnyNames.size) return point;
  let subtract = 0;
  let nextItems = point.manualItems;
  if (point.manualItems) {
    nextItems = { ...point.manualItems };
    for (const name of cnyNames) {
      if (name in nextItems) {
        subtract += Number(nextItems[name]) || 0;
        delete nextItems[name];
      }
    }
  }
  if (subtract <= 0) return point;
  return {
    ...point,
    totalUsd: round2(point.totalUsd - subtract),
    manual: round2((Number(point.manual) || 0) - subtract),
    manualItems: nextItems,
  };
}

