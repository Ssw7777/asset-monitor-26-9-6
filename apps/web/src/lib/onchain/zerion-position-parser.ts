/** Pure parsing/pagination helpers; never logs provider payloads or credentials. */
import {canonicalTokenId} from './token-identity.ts';
import {isJunkTokenSymbol} from './junk-tokens.ts';
export type PositionPartialReason =
  | "page_limit" | "budget" | "deadline" | "http_error"
  | "invalid_response" | "unsafe_next" | "pagination_loop";

export interface ParsedPosition {
  positionId: string;
  symbol: string;
  chain: string;
  type: string;
  amount: number;
  amountExact: string;
  valueUsd: number;
  tokenId: string;
  assetId?: string;
  contractAddress?: string;
  logoUrl?: string;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finite(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Keep the original decimal too: Number is for charts, not an exact balance ledger. */
export function parseZerionQuantity(value: unknown): { amount: number; exact: string } | null {
  const quantity = object(value);
  if (!quantity) return null;
  const numeric = text(quantity.numeric);
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(numeric)) {
    const amount = finite(numeric);
    if (amount !== null && (amount !== 0 || !/[1-9]/.test(numeric.split(/[eE]/)[0]))) {
      return { amount, exact: numeric };
    }
  }
  const integer = text(quantity.int);
  const decimals = finite(quantity.decimals);
  if (/^-?\d+$/.test(integer) && decimals !== null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255) {
    const negative = integer.startsWith("-");
    const digits = (negative ? integer.slice(1) : integer).replace(/^0+(?=\d)/, "").padStart(decimals + 1, "0");
    const exact = `${negative ? "-" : ""}${decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits}`;
    const amount = finite(exact);
    if (amount !== null && (amount !== 0 || !/[1-9]/.test(digits))) return { amount, exact };
  }
  const amount = finite(quantity.float);
  // An underflowed float must not turn a non-zero raw quantity into an empty wallet.
  const rawNonZero = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(numeric)
    ? /[1-9]/.test(numeric.split(/[eE]/)[0]) : /^-?\d+$/.test(integer) && /[1-9]/.test(integer);
  return amount === null || (amount === 0 && rawNonZero) ? null : { amount, exact: String(amount) };
}

export function parseZerionPositionPage(body: unknown, normalizeChain: (value: string) => string) {
  const envelope = object(body);
  if (!envelope || !Array.isArray(envelope.data)
    || (envelope.errors !== undefined && (!Array.isArray(envelope.errors) || envelope.errors.length > 0))) return null;
  const rows: ParsedPosition[] = [];
  let invalidRows = 0;
  for (const item of envelope.data) {
    const row = object(item);
    const attributes = object(row?.attributes);
    const flags = object(attributes?.flags);
    if (flags?.is_trash === true) continue;
    const info = object(attributes?.fungible_info);
    const relationships = object(row?.relationships);
    const chainData = object(object(relationships?.chain)?.data);
    const rawChain = text(chainData?.id);
    const chain = normalizeChain(rawChain);
    const symbol = text(info?.symbol);
    if (symbol && isJunkTokenSymbol(symbol, text(info?.name))) continue;
    const quantity = parseZerionQuantity(attributes?.quantity);
    const positionId = text(row?.id);
    const fungibleId = text(info?.id) || text(object(object(relationships?.fungible)?.data)?.id);
    const implementations = Array.isArray(info?.implementations) ? info.implementations : [];
    const implementation = implementations.map(object).find((entry) => entry && normalizeChain(text(entry.chain_id)) === chain);
    const rawContract = text(implementation?.address);
    const contractAddress = /^0x[0-9a-f]{40}$/i.test(rawContract) ? rawContract.toLowerCase() : rawContract || undefined;
    if (!symbol || !rawChain || chain === "unknown" || !quantity || (!positionId && !fungibleId && !contractAddress)) {
      invalidRows += 1;
      continue;
    }
    const type = text(attributes?.position_type) || "wallet";
    const identity = positionId || `${chain}:${contractAddress || fungibleId}:${type}:${text(attributes?.group_id)}`;
    const price = finite(attributes?.price);
    const value = finite(attributes?.value);
    const derivedValue = price === null ? 0 : Math.abs(quantity.amount * price);
    if (!Number.isFinite(derivedValue)) { invalidRows += 1; continue; }
    const providerTokenId=contractAddress || (fungibleId ? `zerion:${fungibleId}` : `zerion-position:${positionId}`);
    const tokenId=canonicalTokenId({chain,tokenId:providerTokenId,contractAddress,symbol});
    rows.push({
      positionId: identity,
      symbol, chain, type,
      amount: quantity.amount,
      amountExact: quantity.exact,
      valueUsd: value ?? derivedValue,
      // Symbols are labels, not asset IDs: unrelated "USDG" contracts must not merge.
      tokenId,
      assetId: fungibleId && tokenId!==chain ? `zerion:${fungibleId}` : undefined,
      contractAddress,
      logoUrl: text(object(info?.icon)?.url) || undefined,
    });
  }
  const links = envelope.links === undefined ? {} : object(envelope.links);
  if (!links) return null;
  const next = links.next;
  return { rows, invalidRows, next };
}

/** Never forward a Basic credential to a new host, wallet, or endpoint. */
export function safeNextPositionPage(initialUrl: string, next: unknown): string | null {
  const link = typeof next === "string" ? next : text(object(next)?.href);
  if (!link) return null;
  try {
    const initial = new URL(initialUrl);
    const candidate = new URL(link, initial);
    if (candidate.origin !== initial.origin || candidate.pathname !== initial.pathname
      || candidate.username || candidate.password || candidate.hash) return null;
    for (const [key] of candidate.searchParams) {
      if (!key.startsWith("page[") && !initial.searchParams.has(key)) return null;
      if (candidate.searchParams.getAll(key).length !== 1) return null;
    }
    // Cursor-only links must retain the original valuation and position filters.
    for (const [key, value] of initial.searchParams) {
      if (!key.startsWith("page[")) {
        if (candidate.searchParams.has(key) && candidate.searchParams.get(key) !== value) return null;
        candidate.searchParams.set(key, value);
      }
    }
    candidate.searchParams.sort();
    return candidate.href;
  } catch { return null; }
}

export interface PositionPagesResult {
  rows: ParsedPosition[];
  complete: boolean;
  pagesFetched: number;
  partialReason?: PositionPartialReason;
}

export async function readZerionPositionPages(
  initialUrl: string,
  request: (url: string) => Promise<{ status: number; body: unknown }>,
  normalizeChain: (value: string) => string,
  opts: { maxPages?: number; deadlineMs?: number; beforeRequest?: () => boolean | Promise<boolean> } = {},
): Promise<PositionPagesResult | null> {
  // One request remains the default. The caller must explicitly authorize extra pages.
  const maxPages = opts.maxPages === undefined ? 1 : Math.max(0, Math.min(20, Math.floor(Number(opts.maxPages) || 0)));
  const result: PositionPagesResult = { rows: [], complete: false, pagesFetched: 0 };
  const seenPages = new Set<string>();
  const seenRows = new Map<string, ParsedPosition>();
  let url = safeNextPositionPage(initialUrl, initialUrl);
  let partialReason: PositionPartialReason | undefined;
  while (url) {
    if (result.pagesFetched >= maxPages) { partialReason = "page_limit"; break; }
    if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs - 750) { partialReason = "deadline"; break; }
    if (seenPages.has(url)) { partialReason = "pagination_loop"; break; }
    seenPages.add(url);
    let response;
    try {
      if (opts.beforeRequest && !await opts.beforeRequest()) { partialReason = "budget"; break; }
      response = await request(url);
    } catch { partialReason = "http_error"; break; }
    if (response.status !== 200) { partialReason = "http_error"; break; }
    const page = parseZerionPositionPage(response.body, normalizeChain);
    if (!page) { partialReason = "invalid_response"; break; }
    result.pagesFetched += 1;
    for (const row of page.rows) {
      const key = `${row.chain}:${row.positionId}`;
      const existing = seenRows.get(key);
      if (!existing) { seenRows.set(key, row); result.rows.push(row); }
      else if (existing.tokenId !== row.tokenId || existing.amountExact !== row.amountExact || existing.valueUsd !== row.valueUsd) {
        // A changing page set is not an atomic complete wallet snapshot.
        partialReason = "invalid_response";
      }
    }
    if (page.invalidRows || partialReason) { partialReason = "invalid_response"; break; }
    if (page.next === undefined || page.next === null || page.next === "") { result.complete = true; break; }
    url = safeNextPositionPage(initialUrl, page.next);
    if (!url) { partialReason = "unsafe_next"; break; }
  }
  if (!result.pagesFetched) return null;
  if (!result.complete) result.partialReason = partialReason || "unsafe_next";
  return result;
}
