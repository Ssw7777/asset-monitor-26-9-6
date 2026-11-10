/**
 * Read-only check before deploy.
 * Prints the number the refresh would publish (filtered tokens + app + DeFi
 * that is not already in the token list), the reference it is compared with,
 * and the publish / hold decision. Does not write the store.
 *
 *   node --import tsx scripts/probe-wallet-totals.mjs
 *
 * Reads data/store.json, or STORE_PATH. When TURSO_DATABASE_URL is set, reads
 * the live row and does not insert one if it is missing.
 * A live Rabby total is tried until the first 429; after that the stored
 * wallet total is the reference. The refresh itself only calls Rabby for one
 * wallet every few minutes.
 */
import fs from "node:fs";
import path from "node:path";
import { activeRefreshWallets } from "../src/lib/wallets.ts";
import {
  decideWalletPublish,
  explainedTransferUsd,
  fetchBnWalletValuation,
  fetchWrappedNativePrices,
  nativePricesFromTokenCache,
  repeatedRoundKeys,
  uncoveredPositionUsd,
  valueBnWalletTokens,
} from "../src/lib/onchain/bn-wallet-balance.ts";
import { fetchRabbyTotalBalance } from "../src/lib/onchain/debank.ts";

async function loadState() {
  if (process.env.TURSO_DATABASE_URL) {
    const { readLiveStore } = await import("../src/lib/store.ts");
    return readLiveStore();
  }
  const file = process.env.STORE_PATH || path.join(process.cwd(), "data", "store.json");
  if (!fs.existsSync(file)) {
    console.error("No wallet store to read. Set STORE_PATH or TURSO_DATABASE_URL.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function money(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "—";
}

function appUsdOf(chain) {
  return (chain?.chains ?? [])
    .filter((row) => String(row.id || "").startsWith("app:"))
    .reduce((sum, row) => sum + (Number(row.valueUsd) || 0), 0);
}

const state = await loadState();
const wallets = activeRefreshWallets(state.wallets ?? []);
if (!wallets.length) {
  console.error("No active wallets in the store.");
  process.exit(1);
}

const nativePrices = nativePricesFromTokenCache(Object.values(state.tokenCache ?? {}));
const marketPrices = await fetchWrappedNativePrices();
const fetched = [];
let rabbyOpen = true;
for (const wallet of wallets) {
  process.stderr.write(`reading ${wallet.name}\n`);
  const valuation = await fetchBnWalletValuation(wallet.address, { nativePrices, marketPrices });
  let rabby = null;
  let rabbyStatus = 0;
  if (rabbyOpen) {
    const live = await fetchRabbyTotalBalance(wallet.address);
    rabbyStatus = live.status;
    if (live.status === 429 || live.status === 0) rabbyOpen = false;
    else rabby = live.detail;
  }
  fetched.push({ wallet, valuation, rabby, rabbyStatus });
}

const repeated = repeatedRoundKeys(
  fetched.map((row) => ({
    wallet: row.wallet.address.toLowerCase(),
    rows: row.valuation?.roundHoldings ?? [],
  }))
);

const lines = [];
let referenceSum = 0;
let publishSum = 0;
let keptSum = 0;
for (const row of fetched) {
  const address = row.wallet.address.toLowerCase();
  const chain = state.chainCache?.[address];
  const held = chain?.rabbyHeld;
  const valued = row.valuation
    ? valueBnWalletTokens(row.valuation.rawRows, {
        nativePrices,
        marketPrices,
        repeatedRounds: repeated,
        rabbyHeld: held,
      })
    : null;
  const appUsd = appUsdOf(chain);
  const position = uncoveredPositionUsd(valued?.tokens ?? [], state.protocolCache?.[address]?.protocols);
  const stored = Number(row.wallet.balanceUsd) || 0;
  const reference = row.rabby ? Math.round((row.rabby.totalUsd + appUsd) * 100) / 100 : stored > 0 ? stored : null;
  const sinceMs = Date.parse(chain?.rabbyTotalAt ?? row.wallet.lastSuccess?.at ?? "") || Date.now();
  const records = (state.transactionHistory?.[address]?.records ?? []).map((record) => ({
    minedAt: record.minedAt,
    transfers: (record.transfers ?? []).map((transfer) => ({
      sender: transfer.sender,
      recipient: transfer.recipient,
      valueUsd: transfer.valueUsd,
    })),
  }));
  const flowUsd = explainedTransferUsd(records, row.wallet.address, sinceMs);
  const plan = decideWalletPublish({
    tokenUsd: valued?.totalUsd ?? 0,
    appUsd,
    positionUsd: position.usd,
    incompleteNative: !valued || valued.incompleteNative,
    hasRabbyList: (held?.length ?? 0) > 0,
    referenceUsd: reference,
    flowUsd,
    previousUsd: stored,
  });
  if (reference != null) referenceSum += reference;
  publishSum += plan.candidateUsd;
  keptSum += plan.keptUsd;
  const excluded = (valued?.excluded ?? [])
    .filter((token) => token.valueUsd >= 1)
    .map((token) => `${token.symbol} ${token.valueUsd.toFixed(0)} ${token.reason}`)
    .join(", ");
  const parts = [`app ${appUsd.toFixed(0)}`, `defi ${position.usd.toFixed(0)}`];
  lines.push({
    name: row.wallet.name,
    prefix: address.slice(0, 8),
    reference,
    referenceFrom: row.rabby ? "live" : "stored",
    publish: plan.candidateUsd,
    kept: plan.keptUsd,
    delta: reference != null ? plan.candidateUsd - reference : null,
    decision: plan.decision,
    excluded: [excluded, parts.join(" ")].filter((part) => part && part !== "").join(" | ") || "—",
  });
}

const nameWidth = Math.max(8, ...lines.map((line) => line.name.length));
console.log(
  `${"wallet".padEnd(nameWidth)}  prefix    reference    from    publish      kept         delta    decision         notes`
);
for (const line of lines) {
  console.log(
    `${line.name.padEnd(nameWidth)}  ${line.prefix}  ${money(line.reference).padStart(11)}  ${line.referenceFrom.padEnd(6)}  ${money(line.publish).padStart(11)}  ${money(line.kept).padStart(11)}  ${money(line.delta).padStart(8)}  ${line.decision.padEnd(16)}  ${line.excluded}`
  );
}
const delta = publishSum - referenceSum;
const pct = referenceSum > 0 ? (delta / referenceSum) * 100 : 0;
console.log(
  `${"sum".padEnd(nameWidth)}  ${"".padEnd(8)}  ${money(referenceSum).padStart(11)}  ${"".padEnd(6)}  ${money(publishSum).padStart(11)}  ${money(keptSum).padStart(11)}  ${money(delta).padStart(8)}  ${pct.toFixed(2)}%`
);
console.log(
  "publish is the figure a passing wallet would write (tokens + app + DeFi not already in the token list). kept is what this run would leave in the store."
);
if (!rabbyOpen) console.log("Rabby returned 429 or was unreachable; remaining rows use the stored wallet total.");
