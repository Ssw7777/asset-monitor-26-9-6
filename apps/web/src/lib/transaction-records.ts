export interface TransactionRecord {
  hash: string;
  chain: string;
  minedAt: string;
  operation: string;
  transfers: Array<{ sender: string; recipient: string; symbol: string; quantity: string; valueUsd: number | null; contractAddress?:string }>;
}

/** Provider evidence only: no counterparty inference from balance differences. */
export function parseTransactionRecords(body: unknown): TransactionRecord[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) throw new Error("Invalid transaction response");
  const records: TransactionRecord[] = [];
  const seen = new Set<string>();
  for (const item of (body as { data: Array<Record<string, unknown>> }).data) {
    const a = item.attributes as Record<string, unknown> | undefined;
    if (!a || a.status !== "confirmed" || (a.flags as { is_trash?: boolean } | undefined)?.is_trash) continue;
    const hash = typeof a.hash === "string" ? a.hash : "";
    const chain = (item.relationships as { chain?: { data?: { id?: string } } } | undefined)?.chain?.data?.id ?? "";
    if (!/^0x[0-9a-f]{64}$/i.test(hash) || !chain || !Number.isFinite(Date.parse(String(a.mined_at)))) continue;
    if (seen.has(`${chain}:${hash}`)) continue;
    seen.add(`${chain}:${hash}`);
    const transfers = (Array.isArray(a.transfers) ? a.transfers : []).map((transfer) => {
      const t = transfer as Record<string, unknown>;
      const quantity = t.quantity as { numeric?: string; float?: number } | undefined;
      return {
        sender: typeof t.sender === "string" ? t.sender : "未提供",
        recipient: typeof t.recipient === "string" ? t.recipient : "未提供",
        symbol: (t.fungible_info as { symbol?: string } | undefined)?.symbol ?? "未知代币",
        quantity: quantity?.numeric ?? String(quantity?.float ?? "—"),
        valueUsd: typeof t.value === "number" && Number.isFinite(t.value) ? t.value : null,
      };
    });
    records.push({ hash, chain, minedAt: String(a.mined_at), operation: String(a.operation_type ?? "unknown"), transfers });
  }
  return records.sort((a, b) => Date.parse(b.minedAt) - Date.parse(a.minedAt));
}
