import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptNativePrice,
  applyBnWalletTokens,
  binanceGapBlocked,
  bnWalletChainIds,
  chooseWalletTotal,
  countWalletBatch,
  decideWalletPublish,
  expandNativePrices,
  extractBnRawTokens,
  fetchBnWalletValuation,
  fetchWrappedNativePrices,
  explainedTransferUsd,
  rabbyBackoffMs,
  rabbySlotOpen,
  rabbyTotalDiscrepancy,
  repeatedRoundKeys,
  uncoveredPositionUsd,
  valueBnWalletTokens,
  wrappedNativePriceRequests,
  BN_TOTAL_STALE_FALLBACK_MS,
  RABBY_EMPTY_LIST_RETRY_MS,
  RABBY_RECONCILE_GAP_MS,
} from "../src/lib/onchain/bn-wallet-balance.ts";
import { bnWeb3Read } from "../src/lib/onchain/bn-web3.ts";

const credentials = { key: "test-key", secret: "test-secret" };
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const FAKE_HOOD_USDG = "0xbf6295d125b61178ab182bb63875b7fc2d607a70";

function row(partial) {
  return {
    chainId: "eth",
    bnChainId: "1",
    contract: "",
    symbol: "ETH",
    name: "Ethereum",
    amount: 1,
    amountExact: "1",
    price: 1,
    verified: true,
    risk: false,
    liquidity: null,
    ...partial,
  };
}

test("parser reads per-chain tokenAssets and flat balance rows", () => {
  const fromBuckets = extractBnRawTokens({
    code: "0",
    data: [
      {
        binanceChainId: "1",
        tokenAssets: [
          {
            chainIndex: "1",
            tokenContractAddress: USDC,
            symbol: "USDC",
            balance: "25",
            tokenPrice: "1",
            isRiskToken: false,
          },
        ],
      },
    ],
  });
  assert.equal(fromBuckets.length, 1);
  assert.equal(fromBuckets[0].chainId, "eth");
  assert.equal(fromBuckets[0].amount, 25);

  const flat = extractBnRawTokens({
    code: "0",
    data: [
      {
        symbol: "BNB",
        address: "",
        binanceChainId: "56",
        balance: "0.5",
        price: "600",
        isRiskToken: false,
      },
    ],
  });
  assert.equal(flat.length, 1);
  assert.equal(flat[0].chainId, "bsc");
  assert.equal(flat[0].symbol, "BNB");
  assert.equal(flat[0].contract, "");
});

test("filters drop spam, risk, unverified, illiquid, fake, and absurd outliers", () => {
  const valued = valueBnWalletTokens([
    row({ amount: 2, price: 1 }),
    row({
      contract: USDC,
      symbol: "USDC",
      name: "USD Coin",
      amount: 100,
      amountExact: "100",
      price: 1,
      verified: true,
    }),
    row({
      contract: "0x" + "11".repeat(20),
      symbol: "CLAIM",
      name: "Visit claim-airdrop.com now",
      amount: 1000,
      price: 50,
      verified: false,
      risk: true,
    }),
    row({
      contract: "0x" + "55".repeat(20),
      symbol: "RXTOKEN",
      name: "Flagged asset",
      amount: 5,
      price: 10,
      verified: true,
      risk: true,
    }),
    row({
      contract: "0x" + "22".repeat(20),
      symbol: "OBSCURE",
      name: "Project token",
      amount: 10,
      price: 20,
      verified: false,
      liquidity: 100_000,
    }),
    row({
      contract: FAKE_HOOD_USDG,
      chainId: "hood",
      bnChainId: "4663",
      symbol: "USDG",
      name: "United States Global Dollar",
      amount: 10,
      price: 1,
      verified: true,
    }),
    row({
      contract: "0x" + "33".repeat(20),
      symbol: "DUSTLP",
      name: "Thin pool",
      amount: 100,
      price: 2,
      verified: null,
      liquidity: 10,
    }),
    row({
      contract: "0x" + "44".repeat(20),
      symbol: "JUNKVAL",
      name: "Absurd valuation",
      amount: 1,
      price: 80_000,
      verified: null,
      liquidity: null,
    }),
  ], { nativePrices: { eth: 3500 } });

  const symbols = valued.tokens.map((token) => token.symbol).sort();
  // Small unverified or thin-pool rows stay. A large unlisted token with no liquidity does not.
  assert.deepEqual(symbols, ["DUSTLP", "ETH", "OBSCURE", "USDC"]);
  assert.equal(valued.dropped.risk, 1);
  assert.equal(valued.dropped.junk >= 1, true);
  assert.equal(valued.dropped.fake, 1);
  assert.equal(valued.dropped.unknown, 1);
  assert.equal(valued.totalUsd, 7500);
  assert.equal(valued.tokens.find((token) => token.symbol === "ETH").valuationPrice, 3500);
  assert.equal(valued.tokens.find((token) => token.symbol === "ETH").priceSource, "coinstats");
});

test("native price comes from wrapped gas token when CoinStats is absent, never from Binance native price", () => {
  assert.equal(acceptNativePrice("eth", "ETH", 1), false);
  const valued = valueBnWalletTokens([
    row({ amount: 1.5, amountExact: "1.5", price: 1 }),
    row({
      contract: WETH,
      symbol: "WETH",
      name: "Wrapped Ether",
      amount: 0.2,
      amountExact: "0.2",
      price: 3500,
      verified: true,
    }),
  ]);
  const eth = valued.tokens.find((token) => token.symbol === "ETH");
  assert.equal(eth.valuationPrice, 3500);
  assert.equal(eth.valueUsd, 5250);
  assert.equal(valued.incompleteNative, false);
  assert.equal(valued.totalUsd, 5950);
});

test("missing native price does not publish a total that ignores the gas coin", () => {
  const valued = valueBnWalletTokens([
    row({ amount: 1, price: 0.01 }),
    row({
      contract: USDC,
      symbol: "USDC",
      name: "USD Coin",
      amount: 10,
      amountExact: "10",
      price: 1,
      verified: true,
    }),
  ]);
  assert.equal(valued.incompleteNative, true);
  assert.equal(valued.tokens.some((token) => token.symbol === "ETH"), false);
});

test("expandNativePrices copies an ETH quote onto every ETH chain", () => {
  const prices = expandNativePrices({ eth: 3600 });
  assert.equal(prices.arb, 3600);
  assert.equal(prices.base, 3600);
  assert.equal(prices.bsc, undefined);
});

test("reconcile flags only gaps above max($150, 3%) and Rabby never wins over Binance", () => {
  assert.equal(rabbyTotalDiscrepancy(10000, 10200), null);
  const flagged = rabbyTotalDiscrepancy(10000, 10400);
  assert.ok(flagged);
  assert.equal(flagged.threshold, 312);
  assert.equal(rabbyTotalDiscrepancy(100, 400).threshold, 150);

  const now = Date.now();
  const fresh = chooseWalletTotal({
    nowMs: now,
    previousUsd: 1000,
    previousAtMs: now - 60_000,
    previousSource: "bn-web3",
    binanceUsd: 1100,
    rabbyUsd: 9000,
  });
  assert.equal(fresh.source, "bn-web3");
  assert.equal(fresh.usd, 1100);

  const keep = chooseWalletTotal({
    nowMs: now,
    previousUsd: 1000,
    previousAtMs: now - 60_000,
    previousSource: "bn-web3",
    binanceUsd: null,
    rabbyUsd: 5000,
  });
  assert.equal(keep.source, "last-good");
  assert.equal(keep.usd, 1000);

  const fallback = chooseWalletTotal({
    nowMs: now,
    previousUsd: 1000,
    previousAtMs: now - BN_TOTAL_STALE_FALLBACK_MS - 1,
    previousSource: "bn-web3",
    binanceUsd: null,
    rabbyUsd: 1100,
  });
  assert.equal(fallback.source, "rabby");
  assert.equal(fallback.usd, 1100);

  const back = chooseWalletTotal({
    nowMs: now,
    previousUsd: 1100,
    previousAtMs: now - 60_000,
    previousSource: "public",
    binanceUsd: 1050,
    rabbyUsd: 1100,
  });
  assert.equal(back.source, "bn-web3");
  assert.equal(back.usd, 1050);

  const explicitZero = chooseWalletTotal({
    nowMs: now,
    previousUsd: 0,
    previousAtMs: now - 60_000,
    previousSource: "bn-web3",
    binanceUsd: null,
    rabbyUsd: 400,
  });
  assert.equal(explicitZero.source, "last-good");
  assert.equal(explicitZero.usd, 0);
});

test("token cache drops phishing rows on covered chains and keeps RPC quantities", () => {
  const previous = {
    at: "2020-01-01T00:00:00.000Z",
    tokens: [
      {
        chain: "eth",
        symbol: "CLAIM",
        name: "visit airdrop",
        amount: 10,
        valueUsd: 500,
        tokenId: "0x" + "ab".repeat(20),
        kind: "spot",
        isCore: false,
      },
      {
        chain: "eth",
        symbol: "USDC",
        amount: 3,
        amountExact: "3.5",
        valueUsd: 3,
        tokenId: USDC,
        contractAddress: USDC,
        kind: "stable",
        isCore: true,
        quantitySource: "rpc",
        quantityBlock: "0x10",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    unpricedCount: 0,
    unpricedByChain: {},
    coveredChains: ["eth"],
  };
  const next = applyBnWalletTokens(
    previous,
    [
      {
        chain: "eth",
        symbol: "USDC",
        amount: 4,
        amountExact: "4",
        valueUsd: 4,
        valuationPrice: 1,
        tokenId: USDC,
        contractAddress: USDC,
        kind: "stable",
        isCore: true,
      },
    ],
    ["eth"],
    "2026-10-22T00:00:00.000Z"
  );
  assert.equal(next.tokens.length, 1);
  assert.equal(next.tokens[0].symbol, "USDC");
  assert.equal(next.tokens[0].amountExact, "3.5");
  assert.equal(next.tokens[0].quantitySource, "rpc");
  assert.equal(next.tokens[0].valueUsd, 3.5);
  assert.equal(next.source, "bn-web3");
});

test("live probe cases: airdrops drop, real large holdings and tokenized stocks stay", () => {
  const boom = (chainId) => row({
    chainId,
    contract: "0x" + "b0".repeat(20),
    symbol: "BOOM",
    name: "Boom",
    amount: 62_000,
    amountExact: "62000",
    price: 3135 / 62_000,
    verified: false,
    liquidity: 5_000_000,
    risk: false,
  });
  const act = row({
    chainId: "bsc",
    contract: "0x" + "ac".repeat(20),
    symbol: "ACT",
    name: "Act",
    amount: 60_000,
    amountExact: "60000",
    price: 2765 / 60_000,
    verified: false,
    liquidity: 5_000_000,
    risk: false,
  });
  const lineaSpam = [
    row({ contract: "0x" + "a1".repeat(20), symbol: "AICC", name: "AICC", amount: 5740, price: 1, verified: false, liquidity: null }),
    row({
      chainId: "bsc",
      contract: "0x" + "b0".repeat(20),
      symbol: "BOOM",
      name: "Boom",
      amount: 62_000,
      price: 3135 / 62_000,
      verified: false,
      liquidity: null,
    }),
    row({ contract: "0x" + "c0".repeat(20), symbol: "PVC", name: "PVC", amount: 1289, price: 1, verified: false, liquidity: 100 }),
  ];
  const linea = valueBnWalletTokens([
    row({ contract: USDC, symbol: "USDC", name: "USD Coin", amount: 1116, price: 1, verified: true }),
    ...lineaSpam,
  ], { nativePrices: { eth: 3500 } });
  assert.equal(linea.totalUsd, 1116);
  assert.deepEqual(linea.excluded.map((token) => token.symbol).sort(), ["AICC", "BOOM", "PVC"]);

  const peers = ["trust", "xter1", "xter2", "xter4", "xter5", "xter6", "gas", "xter3", "linea"].map((wallet) => ({
    wallet,
    rows: [{ chain: "bsc", symbol: "BOOM", amount: 62_000 }],
  }));
  peers.push(
    ...["trust", "xter1", "xter2", "xter4", "xter5", "xter6", "gas"].map((wallet) => ({
      wallet,
      rows: [{ chain: "bsc", symbol: "ACT", amount: 60_000 }],
    }))
  );
  const repeated = repeatedRoundKeys(peers);
  assert.equal(repeated.has("bsc:BOOM:62000"), true);
  assert.equal(repeated.has("bsc:ACT:60000"), true);
  const trust = valueBnWalletTokens([
    row({ contract: USDC, symbol: "USDC", name: "USD Coin", amount: 420, price: 1, verified: true }),
    boom("bsc"),
    act,
  ], { repeatedRounds: repeated });
  assert.equal(trust.totalUsd, 420);
  assert.deepEqual(trust.excluded.map((token) => token.reason).sort(), ["airdrop", "airdrop"]);

  const binanceWallet = valueBnWalletTokens([
    row({ contract: USDC, symbol: "USDC", name: "USD Coin", amount: 3347, price: 1, verified: true }),
    row({
      chainId: "bsc",
      contract: "0x" + "11".repeat(20),
      symbol: "U",
      name: "U",
      amount: 69_946,
      price: 1,
      verified: false,
      liquidity: null,
    }),
    row({
      chainId: "arb",
      contract: "0x" + "22".repeat(20),
      symbol: "sUSDai",
      name: "Staked USDai",
      amount: 17_094,
      price: 1.05,
      verified: false,
      liquidity: null,
    }),
  ]);
  assert.equal(binanceWallet.totalUsd, 3347 + 69_946 + Math.round(17_094 * 1.05 * 100) / 100);
  assert.equal(binanceWallet.excluded.length, 0);

  const stock = valueBnWalletTokens([
    row({ contract: USDC, symbol: "USDC", name: "USD Coin", amount: 19.06, price: 1, verified: true }),
    row({
      chainId: "base",
      contract: "0x" + "33".repeat(20),
      symbol: "NVDAc",
      name: "NVIDIA",
      amount: 0.0327,
      price: 180,
      verified: false,
      liquidity: 10,
    }),
  ]);
  assert.ok(stock.tokens.some((token) => token.symbol === "NVDAc"));
  assert.ok(stock.totalUsd > 19.06);

  const safePal = valueBnWalletTokens([
    row({
      contract: "0x" + "44".repeat(20),
      symbol: "PET",
      name: "Small cap",
      amount: 5.17,
      price: 1,
      verified: false,
      liquidity: 10,
    }),
  ]);
  assert.equal(safePal.totalUsd, 5.17);

  const freshCoin = row({
    contract: "0x" + "55".repeat(20),
    symbol: "NEWCOIN",
    name: "New coin",
    amount: 1000,
    price: 1,
    verified: true,
    liquidity: 80_000,
  });
  const beforeList = valueBnWalletTokens([freshCoin]);
  assert.equal(beforeList.totalUsd, 1000);
  const afterList = valueBnWalletTokens([freshCoin], {
    rabbyHeld: [{ chain: "eth", id: USDC, symbol: "USDC", amount: 1 }],
  });
  assert.equal(afterList.totalUsd, 0);
  assert.equal(afterList.excluded[0].reason, "unlisted");

  const hoodStocks = valueBnWalletTokens([
    row({
      chainId: "hood",
      contract: "0x" + "66".repeat(20),
      symbol: "MCD",
      name: "McDonald's",
      amount: 2.4,
      price: 301.7,
      verified: false,
      liquidity: null,
    }),
    row({
      chainId: "hood",
      contract: "0x" + "77".repeat(20),
      symbol: "PONS",
      name: "PONS",
      amount: 100,
      price: 8.13,
      verified: false,
      liquidity: 10,
    }),
    row({
      chainId: "hood",
      contract: "0x" + "88".repeat(20),
      symbol: "SCAM",
      name: "Not a stock",
      amount: 1,
      price: 1_000_000,
      verified: false,
      liquidity: null,
    }),
  ]);
  assert.ok(hoodStocks.tokens.some((token) => token.symbol === "MCD"));
  assert.ok(hoodStocks.tokens.some((token) => token.symbol === "PONS"));
  assert.equal(hoodStocks.excluded.find((token) => token.symbol === "SCAM")?.reason, "bad-price");
  assert.ok(hoodStocks.totalUsd > 724 + 813 - 5);

  const held = binanceGapBlocked(11_208, 1_116, 0);
  assert.ok(held);
  assert.equal(binanceGapBlocked(11_208, 1_116, 10_000), null);
  assert.ok(binanceGapBlocked(96_456, 90_445, 0));
  assert.equal(binanceGapBlocked(96_456, 90_445, 0, { softUpward: true }), null);
  assert.ok(binanceGapBlocked(550_469, 164, 0, { softUpward: true }));
  assert.ok(binanceGapBlocked(10, 5_000, 0, { softUpward: true }));
  assert.equal(
    explainedTransferUsd(
      [{ minedAt: new Date().toISOString(), transfers: [{ sender: "0x" + "01".repeat(20), recipient: "0x" + "ab".repeat(20), valueUsd: 10_000 }] }],
      "0x" + "ab".repeat(20),
      Date.now() - 60_000
    ),
    10_000
  );
});

test("balance endpoint is read-only and paginates until a short page", async () => {
  let calls = 0;
  const request = async (url) => {
    calls += 1;
    const page = new URL(url).searchParams.get("page");
    assert.match(String(url), /\/api\/v1\/dex\/balance\/all-token-balances-by-address/);
    assert.match(String(url), /excludeRiskToken=true/);
    const tokens =
      page === "1"
        ? Array.from({ length: 100 }, (_, index) => ({
            chainIndex: "1",
            tokenContractAddress: `0x${index.toString(16).padStart(40, "0")}`,
            symbol: `T${index}`,
            balance: "1",
            tokenPrice: "1",
            isRiskToken: false,
            isVerified: true,
          }))
        : [
            {
              chainIndex: "1",
              tokenContractAddress: USDC,
              symbol: "USDC",
              balance: "5",
              tokenPrice: "1",
              isRiskToken: false,
              isVerified: true,
            },
          ];
    return new Response(JSON.stringify({ code: "0", data: [{ tokenAssets: tokens }] }), { status: 200 });
  };
  const valued = await fetchBnWalletValuation("0x" + "ab".repeat(20), {
    credentials,
    request,
    chainIds: ["1"],
    nativePrices: { eth: 3500 },
  });
  assert.equal(calls, 2);
  assert.equal(valued.tokens.some((token) => token.symbol === "USDC"), true);
  assert.equal(valued.incompleteNative, false);

  await assert.rejects(
    () => bnWeb3Read("/api/v1/dex/trade/build", undefined, { credentials, request }),
    /non_read/
  );
});

test("balance and native-price reads send one chain; a multi-chain query is code 40001", async () => {
  const seenChains = [];
  const request = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/market/price")) {
      const body = JSON.parse(init?.body || "[]");
      const ids = Array.isArray(body) ? body.map((row) => String(row.binanceChainId)) : [];
      if (ids.length !== 1) {
        return new Response(
          JSON.stringify({ code: "40001", message: "Multiple chain IDs in 'chains' are not supported yet" }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          code: "0",
          data: [{ binanceChainId: ids[0], tokenContractAddress: body[0].tokenContractAddress, price: "100" }],
        }),
        { status: 200 }
      );
    }
    const chains = parsed.searchParams.get("chains") || "";
    if (chains.includes(",")) {
      return new Response(
        JSON.stringify({ code: "40001", message: "Multiple chain IDs in 'chains' are not supported yet" }),
        { status: 200 }
      );
    }
    seenChains.push(chains);
    const chainIndex = chains;
    const symbol = chainIndex === "56" ? "BNB" : "ETH";
    return new Response(
      JSON.stringify({
        code: "0",
        data: [
          {
            binanceChainId: chainIndex,
            tokenAssets: [
              {
                chainIndex,
                tokenContractAddress: "",
                symbol,
                balance: "1",
                tokenPrice: "1",
                isRiskToken: false,
              },
            ],
          },
        ],
      }),
      { status: 200 }
    );
  };

  const valued = await fetchBnWalletValuation("0x" + "ab".repeat(20), {
    credentials,
    request,
    chainIds: ["1", "56"],
    nativePrices: { eth: 3500, bsc: 600 },
  });
  assert.ok(valued);
  assert.deepEqual(seenChains.slice().sort(), ["1", "56"]);
  assert.equal(valued.incompleteNative, false);
  assert.equal(valued.totalUsd, 4100);
  assert.deepEqual(valued.queriedChains.slice().sort(), ["bsc", "eth"]);

  const priceBodies = [];
  const priceRequest = async (url, init) => {
    const body = JSON.parse(init?.body || "[]");
    priceBodies.push(body);
    const ids = Array.isArray(body) ? body.map((row) => String(row.binanceChainId)) : [];
    if (ids.length !== 1) {
      return new Response(JSON.stringify({ code: "40001", message: "Multiple chain IDs are not supported yet" }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({
        code: "0",
        data: [{ binanceChainId: ids[0], tokenContractAddress: body[0].tokenContractAddress, price: "100" }],
      }),
      { status: 200 }
    );
  };
  const prices = await fetchWrappedNativePrices({ credentials, request: priceRequest });
  assert.equal(priceBodies.length, wrappedNativePriceRequests());
  assert.ok(priceBodies.every((body) => Array.isArray(body) && body.length === 1));
  assert.equal(prices.eth, 100);
  assert.equal(prices.bsc, 100);
});

test("one full lap is one balance read per chain per wallet plus one price read per wrapped native", () => {
  const chains = bnWalletChainIds();
  const wallets = 16;
  assert.equal(new Set(chains).size, chains.length);
  assert.ok(chains.every((id) => /^\d+$/.test(id)));
  assert.equal(chains.length, 33);
  assert.equal(wrappedNativePriceRequests(), 14);
  assert.equal(wallets * chains.length + wrappedNativePriceRequests(), 542);
});

test("a Binance miss that keeps the last total still completes the wallet-batch round", () => {
  const kept = countWalletBatch([
    { attempted: true, status: "ok", successAt: "t0", previousSuccessAt: "t0" },
    { attempted: true, status: "ok", successAt: "t0", previousSuccessAt: "t0" },
    { attempted: false, status: "ok", successAt: "t0", previousSuccessAt: "t0" },
  ]);
  assert.equal(kept.attempted, 2);
  assert.equal(kept.succeeded, 2);
  assert.equal(kept.observed, 0);

  const published = countWalletBatch([
    { attempted: true, status: "ok", successAt: "t1", previousSuccessAt: "t0" },
  ]);
  assert.equal(published.succeeded, 1);
  assert.equal(published.observed, 1);

  const down = countWalletBatch([
    { attempted: true, status: "error", successAt: "t0", previousSuccessAt: "t0" },
  ]);
  assert.equal(down.succeeded, 0);
  assert.equal(down.observed, 0);
});

test("published total adds app and DeFi that are not already in the token list", () => {
  const receipt = "0x" + "aa".repeat(20);
  const covered = uncoveredPositionUsd(
    [{ chain: "arb", contractAddress: receipt, valueUsd: 50 }],
    [{
      id: "arb_aave",
      chain: "arb",
      _bnProtocolTotalValue: 80,
      portfolio_item_list: [{ stats: { net_usd_value: 80 }, detail: { supply_token_list: [{ id: receipt }] } }],
    }]
  );
  assert.equal(covered.usd, 30);

  const separate = uncoveredPositionUsd(
    [{ chain: "base", contractAddress: "0x" + "bb".repeat(20), valueUsd: 10 }],
    [{
      id: "base_merkl",
      chain: "base",
      portfolio_item_list: [{ stats: { net_usd_value: 26 } }],
    }, {
      id: "app:polymarket",
      chain: "app:polymarket",
      portfolio_item_list: [{ stats: { net_usd_value: 40 } }],
    }]
  );
  assert.equal(separate.usd, 26);
  assert.equal(separate.byChain[0].id, "base");

  const matched = decideWalletPublish({
    tokenUsd: 100,
    appUsd: 20,
    positionUsd: 15,
    incompleteNative: false,
    hasRabbyList: true,
    referenceUsd: 135,
    flowUsd: 0,
    previousUsd: 130,
  });
  assert.equal(matched.decision, "publish");
  assert.equal(matched.candidateUsd, 135);
  assert.equal(matched.keptUsd, 135);

  const withPosition = decideWalletPublish({
    tokenUsd: 7.06,
    appUsd: 0,
    positionUsd: 26.6,
    incompleteNative: false,
    hasRabbyList: true,
    referenceUsd: 33.66,
    flowUsd: 0,
    previousUsd: 33.66,
  });
  assert.equal(withPosition.decision, "publish");
  assert.equal(withPosition.candidateUsd, 33.66);

  const gap = decideWalletPublish({
    tokenUsd: 1000,
    appUsd: 0,
    positionUsd: 0,
    incompleteNative: false,
    hasRabbyList: true,
    referenceUsd: 5000,
    flowUsd: 0,
    previousUsd: 5000,
  });
  assert.equal(gap.decision, "hold-gap");
  assert.equal(gap.keptUsd, 5000);

  const bootstrapCold = decideWalletPublish({
    tokenUsd: 100,
    appUsd: 25,
    positionUsd: 10,
    incompleteNative: false,
    hasRabbyList: false,
    hasRabbyTotal: false,
    referenceUsd: null,
    flowUsd: 0,
    previousUsd: 0,
  });
  assert.equal(bootstrapCold.decision, "hold-bootstrap");
  assert.equal(bootstrapCold.candidateUsd, 135);
  assert.equal(bootstrapCold.keptUsd, 0);

  // Prior published total soft-exits hold-bootstrap and gap-checks vs reference.
  const softPrevious = decideWalletPublish({
    tokenUsd: 100,
    appUsd: 25,
    positionUsd: 10,
    incompleteNative: false,
    hasRabbyList: false,
    hasRabbyTotal: false,
    referenceUsd: 135,
    flowUsd: 0,
    previousUsd: 135,
  });
  assert.equal(softPrevious.decision, "publish");
  assert.equal(softPrevious.candidateUsd, 135);

  const softPreviousGap = decideWalletPublish({
    tokenUsd: 10,
    appUsd: 0,
    positionUsd: 0,
    incompleteNative: false,
    hasRabbyList: false,
    hasRabbyTotal: false,
    referenceUsd: 5000,
    flowUsd: 0,
    previousUsd: 5000,
  });
  assert.equal(softPreviousGap.decision, "hold-gap");
  assert.equal(softPreviousGap.keptUsd, 5000);

  // Soft upward without Rabby list: bn-web3 primary may correct a stale
  // Rabby-era total (币安钱包 ~90k → ~96k) without waiting for reconcile.
  const softUpward = decideWalletPublish({
    tokenUsd: 96_456,
    appUsd: 0,
    positionUsd: 0,
    incompleteNative: false,
    hasRabbyList: false,
    hasRabbyTotal: false,
    referenceUsd: 90_445,
    flowUsd: 0,
    previousUsd: 90_445,
  });
  assert.equal(softUpward.decision, "publish");
  assert.equal(softUpward.candidateUsd, 96_456);
  assert.equal(softUpward.keptUsd, 96_456);

  // Absurd upward junk (Linea-style) still hold-gaps even without Rabby.
  const softAbsurdUp = decideWalletPublish({
    tokenUsd: 550_469,
    appUsd: 0,
    positionUsd: 0,
    incompleteNative: false,
    hasRabbyList: false,
    hasRabbyTotal: false,
    referenceUsd: 164,
    flowUsd: 0,
    previousUsd: 164,
  });
  assert.equal(softAbsurdUp.decision, "hold-gap");
  assert.equal(softAbsurdUp.keptUsd, 164);

  // With a Rabby list, the strict 3% band still applies on upward moves.
  const rabbyListStrictUp = decideWalletPublish({
    tokenUsd: 96_456,
    appUsd: 0,
    positionUsd: 0,
    incompleteNative: false,
    hasRabbyList: true,
    hasRabbyTotal: true,
    referenceUsd: 90_445,
    flowUsd: 0,
    previousUsd: 90_445,
  });
  assert.equal(rabbyListStrictUp.decision, "hold-gap");

  const totalAnchor = decideWalletPublish({
    tokenUsd: 100,
    appUsd: 25,
    positionUsd: 10,
    incompleteNative: false,
    hasRabbyList: false,
    hasRabbyTotal: true,
    referenceUsd: 135,
    flowUsd: 0,
    previousUsd: 135,
  });
  assert.equal(totalAnchor.decision, "publish");
  assert.equal(totalAnchor.candidateUsd, 135);

  const unpriced = decideWalletPublish({
    tokenUsd: 100,
    appUsd: 0,
    positionUsd: 0,
    incompleteNative: true,
    hasRabbyList: true,
    referenceUsd: 100,
    flowUsd: 0,
    previousUsd: 100,
  });
  assert.equal(unpriced.decision, "hold-incomplete");
});

test("Rabby reconcile waits a few minutes and backs off after a 429", () => {
  assert.equal(rabbyBackoffMs(undefined, false), RABBY_RECONCILE_GAP_MS);
  assert.equal(rabbyBackoffMs(RABBY_RECONCILE_GAP_MS, true), RABBY_RECONCILE_GAP_MS * 2);
  assert.equal(rabbyBackoffMs(15 * 60 * 1000, true), 15 * 60 * 1000);
  const now = Date.now();
  assert.equal(rabbySlotOpen([], now), true);
  assert.equal(
    rabbySlotOpen([{ rabbyListAttemptAt: new Date(now - 60_000).toISOString(), rabbyListBackoffMs: RABBY_RECONCILE_GAP_MS }], now),
    false
  );
  assert.equal(
    rabbySlotOpen([{ rabbyListAttemptAt: new Date(now - RABBY_RECONCILE_GAP_MS - 1).toISOString(), rabbyListBackoffMs: RABBY_RECONCILE_GAP_MS }], now),
    true
  );
  assert.equal(RABBY_EMPTY_LIST_RETRY_MS, 6 * 60 * 60 * 1000);
  // Empty-list retry must stay longer than the shared slot gap.
  assert.ok(RABBY_EMPTY_LIST_RETRY_MS > RABBY_RECONCILE_GAP_MS);
});
