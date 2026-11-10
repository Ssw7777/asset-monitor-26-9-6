import { isDustTokenValue, isFakeTokenContract, isJunkTokenSymbol } from "./junk-tokens";
import { bnWeb3Credentials, fetchBnPositionList } from "./bn-web3";

/** Binance chainId (stringified number) → DeBank / Rabby chain slug. */
export const BN_CHAIN_TO_DEBANK: Record<string, string> = {
  "1": "eth",
  "56": "bsc",
  "8453": "base",
  "42161": "arb",
  "10": "op",
  "137": "matic",
  "43114": "avax",
  "4663": "hood",
  "747474": "katana",
  "5042": "arc",
};

const CHAIN_NAMES: Record<string, string> = {
  eth: "Ethereum",
  bsc: "BNB Chain",
  base: "Base",
  arb: "Arbitrum",
  op: "Optimism",
  matic: "Polygon",
  avax: "Avalanche",
  hood: "Robinhood Chain",
  katana: "Katana",
  arc: "ARC",
};

/** Map BN protocol names / ids onto existing Rabby protocol id suffixes where we know them. */
const PROTOCOL_SLUG_ALIASES: Record<string, string> = {
  usd_ai: "usdai",
  usdai: "usdai",
  usd: "usdai",
  astherus: "aster",
  aster: "aster",
  venus: "venus",
  aave_v3: "aave3",
  aave_v4: "aave3",
  aave: "aave3",
  morpho: "morphoblue",
  morphoblue: "morphoblue",
  pendle_v2: "pendle2",
  pendle: "pendle2",
  uniswap_v3: "uniswap3",
  uniswap_v2: "uniswap2",
  uniswap_v4: "uniswap4",
  pancakeswap_v3: "pancake3",
  pancakeswap_v2: "pancake2",
  compound_v3: "compound3",
  lido: "lido",
  ether_fi: "etherfi",
  ethena: "ethena",
  spark: "spark",
  fluid: "fluid",
  sky: "sky",
  lista: "lista",
  solv: "solv",
  maple: "maple",
  frax: "frax",
  benqi: "benqi",
  quickswap: "quickswap",
};

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function bnProtocolId(chain: string, protocolName: string, defiProtocolId: string): string {
  const raw = slugify(defiProtocolId || protocolName || "unknown");
  const alias = PROTOCOL_SLUG_ALIASES[raw] || raw || "unknown";
  return `${chain}_${alias}`;
}

function normalizeNameKey(name: string): string {
  return slugify(name).replace(/_/g, "");
}

type BnToken = {
  tokenAddress?: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenAmount?: string;
  tokenPrice?: string;
  tokenValue?: string;
  tokenDecimals?: string;
};

function isJunkBnToken(chain: string, token: BnToken): boolean {
  const symbol = String(token.tokenSymbol || "").trim();
  const name = String(token.tokenName || "").trim();
  if (!symbol || isJunkTokenSymbol(symbol, name)) return true;
  if (isFakeTokenContract(chain, symbol, token.tokenAddress)) return true;
  return false;
}

function mapTokenList(
  chain: string,
  tokens: BnToken[] | undefined,
  role: "asset" | "debt" | "reward"
): Array<Record<string, unknown>> {
  if (!Array.isArray(tokens)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const token of tokens) {
    if (!token || typeof token !== "object") continue;
    if (isJunkBnToken(chain, token)) continue;
    const amount = num(token.tokenAmount);
    const valueUsd = Math.abs(num(token.tokenValue));
    const price = num(token.tokenPrice);
    // Dust lines inside a real position are kept when the parent net is large;
    // drop only valueless junk that would otherwise clutter the UI.
    if (!amount || (valueUsd < 0.005 && Math.abs(amount * price) < 0.005)) continue;
    if (isDustTokenValue(valueUsd) && valueUsd === 0) continue;
    const address = String(token.tokenAddress || "").toLowerCase();
    const symbol = String(token.tokenSymbol || "TOKEN").trim();
    out.push({
      id: address || symbol,
      chain,
      name: String(token.tokenName || symbol),
      symbol,
      optimized_symbol: symbol,
      decimals: Number(token.tokenDecimals) || 18,
      price,
      amount: role === "debt" ? -Math.abs(amount) : amount,
      usd_value: role === "debt" ? -Math.abs(valueUsd || Math.abs(amount * price)) : valueUsd || Math.abs(amount * price),
      protocol_id: "", // filled by caller
      is_verified: true,
      is_core: false,
      is_wallet: false,
      _bnRole: role,
    });
  }
  return out;
}

/**
 * Convert one address's BN protocolList into DeBank/Rabby-shaped protocol rows.
 * Junk symbols / fake contracts are stripped; empty protocols are dropped.
 */
export function parseBnPositionListForAddress(
  payload: Record<string, unknown>,
  address: string
): { protocols: Record<string, unknown>[]; supplyTokenKeys: Set<string>; poolCas: Set<string> } {
  const normalized = address.toLowerCase();
  const addressList = Array.isArray(payload.addressList) ? payload.addressList : [];
  const row = addressList.find(
    (item) =>
      item &&
      typeof item === "object" &&
      String((item as Record<string, unknown>).address || "").toLowerCase() === normalized
  ) as Record<string, unknown> | undefined;

  const protocols: Record<string, unknown>[] = [];
  const supplyTokenKeys = new Set<string>();
  const poolCas = new Set<string>();

  if (!row) return { protocols, supplyTokenKeys, poolCas };

  const protocolList = Array.isArray(row.protocolList) ? row.protocolList : [];
  for (const raw of protocolList) {
    if (!raw || typeof raw !== "object") continue;
    const proto = raw as Record<string, unknown>;
    const chainId = String(proto.binanceChainId || "");
    const chain = BN_CHAIN_TO_DEBANK[chainId];
    if (!chain) continue; // unsupported / unknown chain — skip, keep Rabby cache for these

    const protocolName = String(proto.protocolName || proto.defiProtocolId || "Unknown");
    const defiProtocolId = String(proto.defiProtocolId || "");
    const id = bnProtocolId(chain, protocolName, defiProtocolId);
    const poolList = Array.isArray(proto.poolList) ? proto.poolList : [];

    const portfolio_item_list: Record<string, unknown>[] = [];
    let assetUsd = 0;
    let debtUsd = 0;

    for (const poolRaw of poolList) {
      if (!poolRaw || typeof poolRaw !== "object") continue;
      const pool = poolRaw as Record<string, unknown>;
      const poolCa = String(pool.poolCa || "").toLowerCase();

      const collections = Array.isArray(pool.positionCollectionList) ? pool.positionCollectionList : [];
      for (const colRaw of collections) {
        if (!colRaw || typeof colRaw !== "object") continue;
        const col = colRaw as Record<string, unknown>;
        const positions = Array.isArray(col.positionList) ? col.positionList : [];
        for (const posRaw of positions) {
          if (!posRaw || typeof posRaw !== "object") continue;
          const pos = posRaw as Record<string, unknown>;
          const tokenList =
            pos.tokenList && typeof pos.tokenList === "object"
              ? (pos.tokenList as Record<string, unknown>)
              : {};

          const supply = mapTokenList(chain, tokenList.supply as BnToken[] | undefined, "asset");
          const borrow = mapTokenList(chain, tokenList.borrow as BnToken[] | undefined, "debt");
          const reward = mapTokenList(chain, tokenList.reward as BnToken[] | undefined, "reward");
          const farming = mapTokenList(chain, tokenList.farming_reward as BnToken[] | undefined, "reward");

          for (const t of [...supply, ...borrow, ...reward, ...farming]) {
            t.protocol_id = id;
          }

          const itemAsset =
            supply.reduce((s, t) => s + Math.abs(num(t.usd_value)), 0) +
            reward.reduce((s, t) => s + Math.abs(num(t.usd_value)), 0) +
            farming.reduce((s, t) => s + Math.abs(num(t.usd_value)), 0);
          const itemDebt = borrow.reduce((s, t) => s + Math.abs(num(t.usd_value)), 0);
          // Prefer BN's positionValue when token filter didn't gut the position.
          const reported = num(pos.positionValue);
          const net =
            reported > 0 && itemAsset + itemDebt > 0
              ? reported
              : itemAsset - itemDebt;
          if (Math.abs(net) < 0.005 && itemAsset < 0.005 && itemDebt < 0.005) continue;

          // If every supply token was junk-filtered but BN still reports value, drop —
          // do not trust opaque USD on spam tickers.
          if (!supply.length && !borrow.length && !reward.length && !farming.length) continue;

          assetUsd += itemAsset || Math.max(0, net);
          debtUsd += itemDebt;

          // Only receipt/pool keys from positions we actually keep (avoid stripping
          // wallet spot for $0 Venus/Morpho dust rows that never become protocol rows).
          for (const t of [...supply, ...borrow, ...reward, ...farming]) {
            const tid = String(t.id || "").toLowerCase();
            if (tid.startsWith("0x")) supplyTokenKeys.add(`${chain}:${tid}`);
          }
          if (poolCa) {
            poolCas.add(`${chain}:${poolCa}`);
            supplyTokenKeys.add(`${chain}:${poolCa}`);
          }

          const poolType = String(pool.poolType || "Deposit");
          portfolio_item_list.push({
            stats: {
              asset_usd_value: itemAsset || Math.max(0, net),
              debt_usd_value: itemDebt,
              net_usd_value: net,
            },
            name: poolType,
            detail_types: ["common"],
            detail: {
              supply_token_list: supply,
              borrow_token_list: borrow,
              reward_token_list: [...reward, ...farming],
            },
            pool: {
              id: String(pool.bnPoolId || poolCa || id),
              chain,
              project_id: id,
              adapter_id: defiProtocolId || id,
            },
            update_at: Math.floor(Date.now() / 1000),
            _assetMonitorSource: "bn-web3",
            _bnPoolCa: poolCa || undefined,
          });
        }
      }
    }

    if (!portfolio_item_list.length) continue;
    const protocolTotal = num(proto.protocolTotalValue);
    const netUsd = protocolTotal > 0 ? protocolTotal : assetUsd - debtUsd;
    if (Math.abs(netUsd) < 0.005) continue;

    protocols.push({
      id,
      chain,
      chain_name: CHAIN_NAMES[chain] || chain,
      name: protocolName,
      site_url: "",
      logo_url: undefined,
      has_supported_portfolio: true,
      portfolio_item_list,
      _assetMonitorSource: "bn-web3",
      _bnDefiProtocolId: defiProtocolId,
      _bnProtocolTotalValue: netUsd,
    });
  }

  return { protocols, supplyTokenKeys, poolCas };
}

/**
 * Merge BN protocols into a previous Rabby/DeBank list:
 * - BN rows replace previous rows with the same id, or same chain + similar name
 * - Previous rows on chains / protocols BN does not cover are kept (Merkl, Sablier, Abstract, …)
 * - App synthetic rows (id starting with app:) are always kept
 */
export function mergeBnProtocolsWithPrevious(
  previous: Record<string, unknown>[],
  bnProtocols: Record<string, unknown>[]
): Record<string, unknown>[] {
  const replaced = new Set<string>();
  const bnIds = new Set(bnProtocols.map((p) => String(p.id)));

  for (const bn of bnProtocols) {
    const bnId = String(bn.id);
    const bnChain = String(bn.chain || "");
    const bnNameKey = normalizeNameKey(String(bn.name || ""));
    for (const prev of previous) {
      const prevId = String(prev.id || "");
      if (prevId.startsWith("app:")) continue;
      if (prevId === bnId) {
        replaced.add(prevId);
        continue;
      }
      const prevChain = String(prev.chain || "");
      const prevNameKey = normalizeNameKey(String(prev.name || prevId));
      if (prevChain === bnChain && prevNameKey && bnNameKey && (prevNameKey === bnNameKey || prevNameKey.includes(bnNameKey) || bnNameKey.includes(prevNameKey))) {
        replaced.add(prevId);
      }
      // Classic Rabby id arb_usdai vs BN arb_usdai already covered by id equality;
      // also match when previous id suffix equals BN alias.
      if (prevChain === bnChain && prevId === bnId) replaced.add(prevId);
    }
  }

  const kept = previous.filter((p) => {
    const id = String(p.id || "");
    if (id.startsWith("app:")) return true;
    if (bnIds.has(id)) return false;
    if (replaced.has(id)) return false;
    return true;
  });

  return [...kept, ...bnProtocols];
}

/** Token-cache keys (chain:address) that belong to DeFi receipt / supply and must not also count as wallet spot. */
export function collectBnDefiTokenKeys(protocols: Record<string, unknown>[]): Set<string> {
  const keys = new Set<string>();
  for (const protocol of protocols) {
    if (protocol._assetMonitorSource !== "bn-web3") continue;
    const chain = String(protocol.chain || "");
    const items = Array.isArray(protocol.portfolio_item_list) ? protocol.portfolio_item_list : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const poolCa = String(row._bnPoolCa || "").toLowerCase();
      if (chain && poolCa) keys.add(`${chain}:${poolCa}`);
      const detail = row.detail && typeof row.detail === "object" ? (row.detail as Record<string, unknown>) : {};
      for (const listName of ["supply_token_list", "borrow_token_list", "reward_token_list"] as const) {
        const list = detail[listName];
        if (!Array.isArray(list)) continue;
        for (const token of list) {
          if (!token || typeof token !== "object") continue;
          const id = String((token as Record<string, unknown>).id || "").toLowerCase();
          if (chain && id.startsWith("0x")) keys.add(`${chain}:${id}`);
        }
      }
    }
  }
  return keys;
}

export function stripDefiReceiptTokens<T extends { chain?: string; tokenId?: string; contractAddress?: string }>(
  tokens: T[],
  receiptKeys: Set<string>
): T[] {
  if (!receiptKeys.size) return tokens;
  return tokens.filter((token) => {
    const chain = String(token.chain || "").toLowerCase();
    const id = String(token.contractAddress || token.tokenId || "").toLowerCase();
    if (!chain || !id.startsWith("0x")) return true;
    return !receiptKeys.has(`${chain}:${id}`);
  });
}

/**
 * Fetch + map BN DeFi positions for one address. Returns null when keys are missing
 * or the address has no usable positions (caller should keep Rabby cache).
 */
export async function fetchBnDefiProtocols(address: string): Promise<{
  protocols: Record<string, unknown>[];
  supplyTokenKeys: Set<string>;
} | null> {
  if (!bnWeb3Credentials()) return null;
  const payload = await fetchBnPositionList([address]);
  const parsed = parseBnPositionListForAddress(payload, address);
  if (!parsed.protocols.length) return { protocols: [], supplyTokenKeys: parsed.supplyTokenKeys };
  return parsed;
}
