import type { TransactionRecord } from "../transaction-records";

/** Chains where Alchemy free-tier getAssetTransfers is known usable in this project. */
const ALCHEMY_TRANSFER_CHAINS: Record<string, string> = {
  eth: "eth-mainnet",
  arb: "arb-mainnet",
  base: "base-mainnet",
  op: "opt-mainnet",
  bsc: "bnb-mainnet",
  matic: "polygon-mainnet",
  linea: "linea-mainnet",
};

export const ALCHEMY_TRANSFER_CHAIN_IDS = Object.keys(ALCHEMY_TRANSFER_CHAINS);

interface AlchemyTransfer {
  hash?: string;
  from?: string;
  to?: string;
  value?: number | null;
  asset?: string | null;
  category?: string;
  rawContract?: { value?: string | null; address?: string | null; decimal?: string | null };
  metadata?: { blockTimestamp?: string };
}

function parseDecimals(decimalStr: string | null | undefined): number | null {
  if (decimalStr == null || String(decimalStr).trim() === "") return null;
  const text = String(decimalStr).trim();
  const parsed = /^0x[0-9a-f]+$/i.test(text) ? Number(text) : Number(text);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 36) return null;
  return parsed;
}

function hexToQty(hex: string | null | undefined, decimals: number): string | null {
  if (!hex || hex === "0x") return null;
  try {
    const raw = BigInt(hex);
    if (raw <= BigInt(0)) return null;
    const base = BigInt(10) ** BigInt(decimals);
    const whole = raw / base;
    const frac = raw % base;
    if (frac === BigInt(0)) return whole.toString();
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${whole}.${fracStr}`;
  } catch {
    return null;
  }
}

/**
 * Alchemy `value` is usually already a human quantity, but it is sometimes null
 * or off by powers of ten. Prefer rawContract when decimals are known.
 * Never assume 18 decimals for an ERC-20: that turns 6-decimal stables into 0.000… dust.
 */
export function alchemyQuantity(row: {
  value?: number | null;
  rawContract?: { value?: string | null; address?: string | null; decimal?: string | null };
}): string | null {
  const decimals = parseDecimals(row.rawContract?.decimal ?? null);
  const fromRaw = decimals == null ? null : hexToQty(row.rawContract?.value ?? null, decimals);
  const human =
    typeof row.value === "number" && Number.isFinite(row.value) && row.value > 0 ? row.value : null;
  if (fromRaw) {
    if (human == null) return fromRaw;
    const rawNumber = Number(fromRaw);
    if (rawNumber > 0 && (human / rawNumber > 2 || rawNumber / human > 2)) return fromRaw;
    return fromRaw;
  }
  if (human != null) return String(human);
  const contract = row.rawContract?.address;
  if (!contract) return hexToQty(row.rawContract?.value ?? null, 18);
  return null;
}

function toRecord(
  chain: string,
  row: AlchemyTransfer,
  tracked: string
): TransactionRecord | null {
  const hash = typeof row.hash === "string" ? row.hash.toLowerCase() : "";
  if (!/^0x[a-f0-9]{64}$/.test(hash)) return null;
  const sender = typeof row.from === "string" ? row.from.toLowerCase() : "";
  const recipient = typeof row.to === "string" ? row.to.toLowerCase() : "";
  if (!/^0x[a-f0-9]{40}$/.test(sender) || !/^0x[a-f0-9]{40}$/.test(recipient)) return null;
  if (sender !== tracked && recipient !== tracked) return null;
  const minedAt = row.metadata?.blockTimestamp;
  if (!minedAt || !Number.isFinite(Date.parse(minedAt))) return null;
  const contract = row.rawContract?.address ? String(row.rawContract.address).toLowerCase() : "";
  if (contract && !/^0x[a-f0-9]{40}$/.test(contract)) return null;
  const quantity = alchemyQuantity(row);
  if (!quantity || !(Number(quantity) > 0)) return null;
  const symbol = (row.asset && String(row.asset).trim()) || (contract ? "TOKEN" : "NATIVE");
  const operation = sender === tracked ? "send" : "receive";
  return {
    hash,
    chain,
    minedAt: new Date(minedAt).toISOString(),
    operation,
    transfers: [
      {
        sender,
        recipient,
        symbol,
        quantity,
        valueUsd: null,
        contractAddress: contract || undefined,
      },
    ],
  };
}

async function alchemyRpc(
  net: string,
  apiKey: string,
  method: string,
  params: unknown[],
  timeoutMs: number
): Promise<unknown> {
  const response = await fetch(`https://${net}.g.alchemy.com/v2/${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 429) throw new Error("alchemy_http_429");
  if (!response.ok) throw new Error(`alchemy_http_${response.status}`);
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error("alchemy_rpc_error");
  return body.result;
}

/**
 * Read recent native + ERC20 transfers for one address on selected Alchemy chains.
 * Two queries per chain (from / to). Respects a hard call budget for serverless.
 */
export async function fetchAlchemyTransfersForWallet(
  address: string,
  options: {
    chains?: string[];
    maxCount?: number;
    lookbackMs?: number;
    timeoutMs?: number;
    apiKey?: string;
  } = {}
): Promise<{ records: TransactionRecord[]; calls: number; chains: string[]; error?: string }> {
  const apiKey = options.apiKey ?? process.env.ALCHEMY_API_KEY;
  if (!apiKey) return { records: [], calls: 0, chains: [], error: "alchemy_key_missing" };
  const tracked = address.toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(tracked)) return { records: [], calls: 0, chains: [], error: "bad_address" };
  const chains = (options.chains ?? ["eth", "base", "arb"]).filter((id) => ALCHEMY_TRANSFER_CHAINS[id]);
  const maxCount = Math.min(40, Math.max(5, options.maxCount ?? 20));
  const lookbackMs = options.lookbackMs ?? 7 * 86_400_000;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const cutoff = Date.now() - lookbackMs;
  const byKey = new Map<string, TransactionRecord>();
  let calls = 0;

  try {
    for (const chain of chains) {
      const net = ALCHEMY_TRANSFER_CHAINS[chain];
      for (const direction of ["fromAddress", "toAddress"] as const) {
        calls += 1;
        const result = (await alchemyRpc(
          net,
          apiKey,
          "alchemy_getAssetTransfers",
          [
            {
              [direction]: tracked,
              category: ["external", "erc20"],
              withMetadata: true,
              excludeZeroValue: true,
              maxCount: `0x${maxCount.toString(16)}`,
              order: "desc",
            },
          ],
          timeoutMs
        )) as { transfers?: AlchemyTransfer[] } | null;
        const rows = Array.isArray(result?.transfers) ? result!.transfers! : [];
        for (const row of rows) {
          const record = toRecord(chain, row, tracked);
          if (!record || Date.parse(record.minedAt) < cutoff) continue;
          const id = `${record.chain}:${record.hash}`;
          const previous = byKey.get(id);
          if (previous) {
            for (const t of record.transfers) {
              if (
                !previous.transfers.some(
                  (p) =>
                    p.sender === t.sender &&
                    p.recipient === t.recipient &&
                    p.quantity === t.quantity &&
                    p.contractAddress === t.contractAddress
                )
              ) {
                previous.transfers.push(t);
              }
            }
          } else {
            byKey.set(id, record);
          }
        }
      }
    }
  } catch (error) {
    return {
      records: [...byKey.values()].sort((a, b) => Date.parse(b.minedAt) - Date.parse(a.minedAt)),
      calls,
      chains,
      error: error instanceof Error && /^alchemy_[a-z0-9_]+$/.test(error.message) ? error.message : "alchemy_request_failed",
    };
  }

  return {
    records: [...byKey.values()].sort((a, b) => Date.parse(b.minedAt) - Date.parse(a.minedAt)),
    calls,
    chains,
  };
}
