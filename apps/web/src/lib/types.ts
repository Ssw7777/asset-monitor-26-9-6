export type ChainType = "EVM" | "ABSTRACT";

export type TokenKind = "stable" | "native" | "spot";

/** A single on-chain token line shown under a chain (stablecoin / native / spot). */
export interface TokenLine {
  symbol: string;
  amount: number;
  valueUsd: number;
  /** DeBank token id, e.g. `eth` or `0x…` */
  tokenId: string;
  assetId?: string;
  contractAddress?: string;
  /** Original upstream decimal, retained separately from floating-point chart values. */
  amountExact?: string;
  quantitySource?: "rpc" | "okx-web3";
  quantityBlock?: string;
  priceUpdatedAt?: string;
  priceSource?: 'coinstats' | 'okx-web3';
  valuationPrice?: number;
  updatedAt?: string;
  kind: TokenKind;
  isCore: boolean;
  /** 代币图标（DeBank CDN），拿不到时前端回退为字母图标 */
  logoUrl?: string;
}

export interface TokenWalletShare {
  walletId: string;
  walletName: string;
  address: string;
  amount: number;
  valueUsd: number;
}

/** 跨钱包聚合后的代币行：DeBank 钱包页那种“代币 / 价格 / 数量 / 价值”表格的数据源。 */
export interface TokenHolding {
  id: string;
  symbol: string;
  chain: string;
  chainName: string;
  amount: number;
  price: number;
  priceSource?: 'coinstats' | 'okx-web3';
  valueUsd: number;
  kind: TokenKind;
  logoUrl?: string;
  walletCount: number;
  wallets: TokenWalletShare[];
}

export interface ManualAsset {
  id: string;
  name: string;
  /** 折合 USDT，计入总额 / 快照。旧数据仅有此字段。 */
  amountUsd: number;
  /** 记账单位。缺省或 USD = USDT；CNY = 人民币。 */
  currency?: "USD" | "CNY";
  /** 本币金额（CNY 条为人民币，USD 条与 amountUsd 相同）。旧数据可缺省。 */
  amount?: number;
  updatedAt: string;
}

export interface Wallet {
  id: string;
  name: string;
  address: string;
  chain: ChainType;
  balanceUsd: number;
  lastUpdated: string | null;
  /** ok = live; cached = kept last good / TTL; error = refresh failed; baseline = seed only (pre-refresh) */
  status: "ok" | "cached" | "stale" | "error" | "baseline";
  /** Audit fields — optional so existing persisted wallets keep working. */
  createdAt?: string | null;
  updatedAt?: string | null;
  /** Last successful refresh: timestamp + balance at that moment. */
  lastSuccess?: { at: string; balanceUsd: number } | null;
  /** public = DeBank/Rabby；bn-web3 = filtered Binance wallet balances; public-partial = App 暂缺。 */
  source?: "public" | "public-partial" | "zerion" | "direct" | "bn-web3";
  /** true = 暂停自动刷新（页面仍展示最后余额，不进 targets/observation/cron）。 */
  refreshPaused?: boolean;
}

export type ExchangeId = "okx" | "binance" | "gate" | "gate_b" | "gate_c" | "bitget";

export interface ExchangeBalance {
  exchange: ExchangeId;
  balanceUsd: number;
  lastUpdated: string | null;
  status: "ok" | "missing_keys" | "missing_passphrase" | "error" | "baseline";
  error?: string;
}

export interface SnapshotPoint {
  ts: string;
  totalUsd: number;
  onchain?: number;
  cex?: number;
  manual?: number;
  exchanges?: Record<string, number>;
  wallets?: Record<string, number>;
  /** 手动资产按条目名称记录，便于解释变化来源。 */
  manualItems?: Record<string, number>;
  /** DApp/协议净值快照，仅用于解释变化来源，绝不累加进总额。 */
  dapps?: Record<string, number>;
  /** 本轮是否有地址沿用上次成功数据（部分成功）。 */
  partial?: boolean;
  /** true 表示这是首次部署写入的演示基线快照，等待真实刷新数据替换。 */
  seeded?: boolean;
  /** 余额口径升级当轮需要忽略的交易所，避免把算法差额误记为真实流水。 */
  suppressExchangeFlows?: string[];
  /**
   * Manual rows removed in this snapshot because a live Gate account replaced
   * them. Their disappearance is a bookkeeping move, not an outflow.
   */
  suppressManualFlows?: string[];
  /** 本快照里这些地址的余额来自 Zerion 兜底读数；相邻快照任一侧为兜底值时不记流水（估值口径切换，不是真实资金变动）。 */
  zerionWallets?: string[];
  /** 本快照每个地址的余额口径（public / direct）；某地址口径在相邻快照间切换的那一轮不记流水。 */
  walletBasis?: Record<string, string>;
}

export type FlowDirection = "in" | "out" | "transfer";
export type FlowEntityType = "wallet" | "exchange" | "manual";

/** A durable balance-change alert captured when a snapshot is written. */
export interface FlowEvent {
  id: string;
  ts: string;
  direction: FlowDirection;
  amountUsd: number;
  before: number;
  after: number;
  changePct: number | null;
  entityType: FlowEntityType;
  entityKey: string;
  entityLabel: string;
  entityAddress: string | null;
  from: string;
  to: string;
  matched: boolean;
  counterparty: string | null;
  status: "live" | "cached" | "partial";
}

export interface ChainWalletShare {
  walletId: string;
  walletName: string;
  address: string;
  valueUsd: number;
}

export interface ChainAllocation {
  id: string;
  name: string;
  /** DeBank 链图标，链卡片与筛选条直接用官方图标 */
  logoUrl?: string;
  valueUsd: number;
  walletUsd: number;
  dappUsd: number;
  walletCount: number;
  wallets: ChainWalletShare[];
  /** 钱包内未进入协议的稳定币（USDT/USDC/USDG/USDe/USD1…） */
  stablecoins?: TokenLine[];
  /** 钱包内主链币与非稳定币现货 */
  spot?: TokenLine[];
  stableUsd?: number;
  spotUsd?: number;
  nativeUsd?: number;
  /** 估值为 0 或无法识别的代币数量，不计入总额 */
  unpricedCount?: number;
  /** 该链是否真正取到了代币明细（无 AccessKey 时只覆盖少数链） */
  tokenDetailAvailable?: boolean;
}

export interface DappTokenPosition {
  symbol: string;
  amount: number;
  valueUsd: number;
  role: "asset" | "debt" | "reward";
}

export interface DappWalletShare {
  walletId: string;
  walletName: string;
  address: string;
  assetUsd: number;
  debtUsd: number;
  netUsd: number;
  tokens: DappTokenPosition[];
}

export interface DappChainAllocation {
  id: string;
  name: string;
  assetUsd: number;
  debtUsd: number;
  netUsd: number;
  wallets: DappWalletShare[];
}

export interface DappAllocation {
  id: string;
  name: string;
  siteUrl: string;
  /** DeBank 协议图标（官方 CDN 地址，直接复用 DeBank 的图） */
  logoUrl?: string;
  assetUsd: number;
  debtUsd: number;
  netUsd: number;
  chains: DappChainAllocation[];
  wallets: DappWalletShare[];
  /** 数据来源：zerion = 实时仓位；audit = 审计快照（仅展示，不并入总额）。 */
  source?: "zerion" | "audit";
}

export interface OnchainBreakdown {
  generatedAt: string;
  walletCount: number;
  successfulWallets: number;
  chains: ChainAllocation[];
  dapps: DappAllocation[];
  /** 全部钱包的代币聚合（按价值降序），代币表格与链筛选的数据源。 */
  tokens: TokenHolding[];
  /** 已取到明细的钱包代币合计，用于和链总额做“覆盖率”说明 */
  tokensTotalUsd: number;
  /** 当前生效的代币数据源（debank / zerion / rabby-public） */
  tokenSource?: "debank" | "zerion" | "rabby-public" | "rpc" | "none";
  /** Independent token-detail checks; wallet-total freshness cannot stand in for this. */
  tokenAudit?: TokenAuditSummary;
  /** true 表示部分地址沿用上次成功数据（限流或失败） */
  partial?: boolean;
  /** 本轮沿用缓存/上次成功数据的地址数量 */
  cachedWallets?: number;
  /** 公共接口被限流时的冷却截止时间（ISO），到期后自动恢复完整明细 */
  rateLimitedUntil?: string | null;
}

/** Encrypted AES-256-GCM payload for optional CEX key material — never returned to client */
export interface EncryptedSecretsBlob {
  ciphertext: string;
  iv: string;
  tag: string;
  updatedAt: string;
}

/** 某个地址的代币明细缓存（服务端持久化，避免每次冷启动都去消耗 API 额度）。 */
export interface WalletTokenCacheEntry {
  at: string;
  source?: "debank" | "zerion" | "rabby-public" | "bn-web3";
  lastError?: string;
  chainUpdatedAt?: Record<string, string>;
  chainAttemptAt?: Record<string, string>;
  chainErrors?: Record<string, string>;
  tokenErrors?: Record<string, string>;
  tokenAttemptAt?: Record<string, string>;
  identityAttemptAt?: string;
  /** Includes zero/unpriced known tokens so disappearance never stops future checks. */
  inventory?: Record<string, { amount: number; updatedAt: string; amountExact?: string; decimals?: number }>;
  rpcTokenMetadata?: Record<string, TokenLine & {chain:string}>;
  /** 最近一次向代币数据源发起请求的时间；失败也记录，用于严格控制每日额度。 */
  lastAttemptAt?: string;
  tokens: Array<TokenLine & { chain: string }>;
  unpricedCount: number;
  unpricedByChain: Record<string, number>;
  coveredChains: string[];
}

export interface TokenAuditSummary {
  rpc?: { total: number; fresh: number; failed: number; oldestAt: string | null };
  checkedAt: string;
  walletCount: number;
  freshWallets: number;
  staleWallets: number;
  missingWallets: number;
  failedWallets: number;
  invalidRows: number;
  duplicateRows: number;
  aggregateMismatches: number;
  oldestUpdatedAt: string | null;
  healthy: boolean;
  wallets: Array<{
    walletId: string;
    updatedAt: string | null;
    source: string;
    status: "fresh" | "stale" | "missing" | "error";
    tokenCount: number;
  }>;
}

/** 某个地址的 DeFi 协议明细缓存（服务端持久化，避免 Vercel 冷启动后丢失多钱包仓位）。 */
export interface WalletProtocolCacheEntry {
  protocolRpcOwnership?: Record<string,{at:string;block:string}>;
  protocolUpdatedAt?: Record<string,string>;
  at: string;
  /** Last upstream attempt, including failures, so one bad address cannot retry every minute. */
  lastAttemptAt?: string;
  lastError?: string;
  /** Last successful DeBank/Rabby protocol pull (BN Web3 is primary; Rabby reconciles daily). */
  rabbyAt?: string;
  /** Which upstream produced the latest successful protocol pull. */
  protocolSource?: "bn_web3" | "rabby";
  protocols: Record<string, unknown>[];
  /** DeBank App assets (for example Polymarket) are outside the normal chain total endpoint. */
  appAt?: string;
  appLastAttemptAt?: string;
  apps?: Record<string, unknown>[];
}

/** 某个地址的 Zerion 实时 DeFi 仓位（deposit/staked/reward；loan 不并入）。 */
export interface ZerionDefiCacheEntry {
  at: string;
  netUsd: number;
  positions: Array<{ name: string; chain: string; valueUsd: number }>;
}

/** 某个地址的 Zerion 长尾链代币缓存（1 小时 TTL，负责链发现与链级对账）。 */
export interface WalletLongtailCacheEntry {
  at: string;
  chains: Array<{ id: string; name: string; valueUsd: number }>;
  /** Zerion 每链合计快照：缓存期内继续做链级对账。 */
  chainSnapshot?: Record<string, number>;
}

/** Per-wallet chain allocation persisted across serverless cold starts. */
export interface WalletChainCacheEntry {
  at: string;
  totalUsd: number;
  chains: Array<{
    id: string;
    name: string;
    valueUsd: number;
    logoUrl?: string;
  }>;
  /** Which upstream last wrote the published wallet total. */
  balanceSource?: "bn-web3" | "rabby";
  /** Last Rabby total_balance read used only as a daily reconciliation check. */
  rabbyTotalAt?: string;
  rabbyTotalUsd?: number;
  /** Tokens Rabby counted on that reconcile. Missing means unknown, not empty. */
  rabbyHeld?: Array<{ chain: string; id: string; symbol: string; amount: number }>;
  /** Last attempt to store that token list, shared so reconciles stay a few minutes apart. */
  rabbyListAttemptAt?: string;
  /** How long to wait after rabbyListAttemptAt. Grows after a 429. */
  rabbyListBackoffMs?: number;
  /** When token_list last returned a confirmed empty array (API still 200). */
  rabbyListEmptyAt?: string;
  /** Large round balances seen here, used to spot the same airdrop on other wallets. */
  roundHoldings?: Array<{ chain: string; symbol: string; amount: number }>;
}

export interface PortfolioState {
  web3Audit?: {
    cooldownUntil?:string;metadataAt?:string;balanceChains?:string[];defiChains?:string[];lastCycleAt?:string;
    usage?:{month:string;reservedCalls:number};
    wallets:Record<string,{lastAttemptAt:string;retryAt?:string;tokensAt?:string;tokenCount?:number;protocolAt?:string;fablesAbsentSince?:string;error?:string;protocolError?:string;historyError?:string;historyAt?:string}>;
  };
  transactionHistory?:Record<string,{at:string;source:'okx-web3'|'alchemy'|'zerion';more:boolean;records:import('./transaction-records').TransactionRecord[]}>;
  marketAudit?: {month:string;reservedCredits:number;lastAttemptAt?:string;lastSuccessAt?:string;cooldownUntil?:string;remainingCredits?:number;error?:string;updated?:number};
  rpcAudit?: {
    fablesWallets?: Record<string,{lastAttemptAt:string;at?:string;block?:string;error?:string}>;
    protocols?: Record<string,{at?:string;block?:string;wallets?:number;error?:string}>;
    cooldownUntil?: string;
    usage: { month: string; reservedCu: number };
    chains: Record<string, { lastAttemptAt: string; lastSuccessAt?: string; successful?: number; failed?: number; error?: string }>;
    quantities: Record<string, { at: string; error?: string; amountExact?: string; decimals?: number; block?: string }>;
  };
  /** Optimistic-concurrency token for the single persisted Turso document. Never exposed to clients. */
  storeRevision?: string;
  manual: ManualAsset[];
  wallets: Wallet[];
  exchanges: ExchangeBalance[];
  snapshots: SnapshotPoint[];
  /** Long-lived flow alerts. These survive the seven-day snapshot rotation. */
  flowEvents?: FlowEvent[];
  /** Only snapshots at or after this instant may create/display inferred balance-change records. */
  flowBaselineAt?: string | null;
  /** Bumped when the balance basis changes so old inferred records stay archived, not mixed in. */
  flowDataVersion?: number;
  onchainCacheUsd: number;
  lastRefresh: string | null;
  /** Last successfully persisted wallet observation from either refresh path. */
  lastWalletObservationAt?: string | null;
  /** 最近一次「全量刷新」（链上 + DApp + 代币）的时间，用于自动判断该跑 fast 还是 full */
  lastFullRefreshAt?: string | null;
  /** 各交易所已启用的全账户估值口径版本。 */
  cexValuationVersions?: Partial<Record<ExchangeBalance["exchange"], number>>;
  usdCnyRate: number;
  onchainBreakdown?: OnchainBreakdown | null;
  /** 逐地址的代币明细缓存（服务端专用，不下发浏览器） */
  tokenCache?: Record<string, WalletTokenCacheEntry>;
  /** 逐地址的协议明细缓存（服务端专用，不下发浏览器） */
  protocolCache?: Record<string, WalletProtocolCacheEntry>;
  /** 逐地址的链分布缓存（服务端专用，避免 Serverless 冷启动丢失其他批次） */
  chainCache?: Record<string, WalletChainCacheEntry>;
  /** 逐地址的 Zerion 实时 DeFi 仓位缓存（服务端专用，3 小时 TTL） */
  zerionDefi?: Record<string, ZerionDefiCacheEntry>;
  /** 逐地址的 Zerion 长尾链缓存（服务端专用，1 小时 TTL，负责链发现） */
  longtailCache?: Record<string, WalletLongtailCacheEntry>;
  /** Zerion 兜底当日用量计数 { date: YYYY-MM-DD, count }，硬上限防止免费额度被单日故障打爆。 */
  zerionFallback?: { date: string; count: number };
  /** Optional encrypted CEX keys at rest (server-only) */
  encryptedSecrets?: EncryptedSecretsBlob | null;
}

export interface CexKeyMaterial {
  okx?: { apiKey?: string; apiSecret?: string; passphrase?: string; simulated?: boolean };
  binance?: { apiKey?: string; apiSecret?: string };
  gate?: { apiKey?: string; apiSecret?: string };
  bitget?: { apiKey?: string; apiSecret?: string; passphrase?: string };
}
