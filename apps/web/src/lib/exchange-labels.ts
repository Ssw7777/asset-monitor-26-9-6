import type { ExchangeId } from "./types";

/** Public labels. Optional Gate rows stay distinct from the primary Gate line. */
export const EXCHANGE_LABEL: Record<ExchangeId, string> = {
  okx: "OKX",
  binance: "Binance",
  gate: "Gate",
  gate_b: "Gate B",
  gate_c: "Gate C",
  bitget: "Bitget",
};

export function exchangeLabel(id: string): string {
  return EXCHANGE_LABEL[id as ExchangeId] || id;
}

/** Optional Gate rows reuse the Gate mark; there is no separate icon asset. */
export function exchangeIconId(id: string): string {
  if (id === "gate_b" || id === "gate_c") return "gate";
  return id;
}
