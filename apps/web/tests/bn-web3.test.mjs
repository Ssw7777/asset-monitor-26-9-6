import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import {
  bnWeb3Credentials,
  bnWeb3Headers,
  bnWeb3Sign,
  bnWeb3Timestamp,
  bnWeb3Read,
  fetchBnPositionList,
} from "../src/lib/onchain/bn-web3.ts";
import {
  bnProtocolId,
  parseBnPositionListForAddress,
  mergeBnProtocolsWithPrevious,
  collectBnDefiTokenKeys,
  stripDefiReceiptTokens,
} from "../src/lib/onchain/bn-web3-observation.ts";
import { isJunkTokenSymbol } from "../src/lib/onchain/junk-tokens.ts";

const key = "test-key";
const secret = "test-secret";
const credentials = { key, secret };

test("signature uses /build prefix, timestamp+method+path+body, and unique nonce", () => {
  const ts = "2026-10-18T05:30:00.123Z";
  const path = "/build/api/v1/defi/data/position/list";
  const body = '{"addressList":["0xabc"]}';
  const expected = createHmac("sha256", secret)
    .update(ts + "POST" + path + body)
    .digest("base64");
  assert.equal(bnWeb3Sign(secret, ts, "POST", path, body), expected);
  const headers = bnWeb3Headers(credentials, "POST", path, body, ts, "nonce-1");
  assert.equal(headers["X-OC-APIKEY"], key);
  assert.equal(headers["X-OC-TIMESTAMP"], ts);
  assert.equal(headers["X-OC-SIGN"], expected);
  assert.equal(headers["X-OC-NONCE"], "nonce-1");
  assert.ok(bnWeb3Timestamp(new Date("2026-10-18T05:30:00.123Z")).endsWith("Z"));
});

test("credentials ignore exchange BINANCE_API_* and require BN_WEB3_*", () => {
  const prevKey = process.env.BN_WEB3_API_KEY;
  const prevSecret = process.env.BN_WEB3_API_SECRET;
  try {
    delete process.env.BN_WEB3_API_KEY;
    delete process.env.BN_WEB3_API_SECRET;
    process.env.BINANCE_API_KEY = "exchange";
    process.env.BINANCE_API_SECRET = "exchange-secret";
    assert.equal(bnWeb3Credentials(), null);
    process.env.BN_WEB3_API_KEY = "bx";
    process.env.BN_WEB3_API_SECRET = "sec";
    assert.deepEqual(bnWeb3Credentials(), { key: "bx", secret: "sec" });
  } finally {
    if (prevKey === undefined) delete process.env.BN_WEB3_API_KEY;
    else process.env.BN_WEB3_API_KEY = prevKey;
    if (prevSecret === undefined) delete process.env.BN_WEB3_API_SECRET;
    else process.env.BN_WEB3_API_SECRET = prevSecret;
  }
});

test("transport blocks non-readonly paths and never calls trade endpoints", async () => {
  let calls = 0;
  const request = async () => {
    calls += 1;
    return new Response(JSON.stringify({ code: "0", data: {} }), { status: 200 });
  };
  await assert.rejects(
    () => bnWeb3Read("/api/v1/defi/tx/deposit", {}, { credentials, request }),
    /non_read/
  );
  await assert.rejects(
    () => bnWeb3Read("/api/v1/dex/trade/build", {}, { credentials, request }),
    /non_read/
  );
  assert.equal(calls, 0);
});

test("429 respects Retry-After then succeeds; position list batches max 3", async () => {
  let calls = 0;
  const request = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("{}", { status: 429, headers: { "Retry-After": "1" } });
    }
    return new Response(
      JSON.stringify({
        code: "0",
        data: { addressList: [], totalValue: "0" },
      }),
      { status: 200 }
    );
  };
  const data = await bnWeb3Read(
    "/api/v1/defi/data/position/list",
    { addresses: ["0x1"] },
    { credentials, request, maxRetries: 2 }
  );
  assert.equal(String(data.code), "0");
  assert.equal(calls, 2);
  await assert.rejects(
    () =>
      fetchBnPositionList(["0x1", "0x2", "0x3", "0x4"], {
        credentials,
        request: async () => new Response("{}", { status: 200 }),
      }),
    /batch_too_large/
  );
});

test("USDai position maps to arb_usdai-shaped row; junk supply tokens are dropped", () => {
  assert.equal(bnProtocolId("arb", "USD.AI", ""), "arb_usdai");
  assert.equal(bnProtocolId("bsc", "Aster", "astherus"), "bsc_aster");
  const payload = {
    addressList: [
      {
        address: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        protocolList: [
          {
            binanceChainId: "42161",
            defiProtocolId: "",
            protocolName: "USD.AI",
            protocolTotalValue: "17075.09",
            poolList: [
              {
                bnPoolId: "pool1",
                poolCa: "0x0b2b2b2076d95dda7817e785989fe353fe955ef9",
                poolType: "Yield",
                positionCollectionList: [
                  {
                    positionCollectionTotalValue: "17075.09",
                    positionList: [
                      {
                        positionValue: "17075.09",
                        tokenList: {
                          supply: [
                            {
                              tokenAddress: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef",
                              tokenName: "USDai",
                              tokenSymbol: "USDai",
                              tokenAmount: "17081.08",
                              tokenPrice: "0.99965",
                              tokenValue: "17075.09",
                              tokenDecimals: "18",
                            },
                            {
                              tokenAddress: "0xdead",
                              tokenName: "Visit claim-airdrop.com now",
                              tokenSymbol: "CLAIM",
                              tokenAmount: "999999",
                              tokenPrice: "1",
                              tokenValue: "999999",
                              tokenDecimals: "18",
                            },
                          ],
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            binanceChainId: "2741",
            defiProtocolId: "kona",
            protocolName: "Kona",
            protocolTotalValue: "0.4",
            poolList: [],
          },
        ],
      },
    ],
  };
  const parsed = parseBnPositionListForAddress(
    payload,
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  );
  assert.equal(parsed.protocols.length, 1);
  assert.equal(parsed.protocols[0].id, "arb_usdai");
  assert.equal(parsed.protocols[0].chain, "arb");
  const items = parsed.protocols[0].portfolio_item_list;
  assert.equal(items.length, 1);
  const supply = items[0].detail.supply_token_list;
  assert.equal(supply.length, 1);
  assert.equal(supply[0].symbol, "USDai");
  assert.ok(parsed.supplyTokenKeys.has("arb:0x0b2b2b2076d95dda7817e785989fe353fe955ef9"));
  assert.ok(parsed.supplyTokenKeys.has("arb:0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef"));
  assert.ok(isJunkTokenSymbol("CLAIM", "Visit claim-airdrop.com now"));
});

test("merge keeps Merkl/Sablier/Abstract and replaces overlapping USD.AI", () => {
  const previous = [
    { id: "arb_usdai", chain: "arb", name: "USD.AI", portfolio_item_list: [{ stale: true }] },
    { id: "base_merkl", chain: "base", name: "Merkl", portfolio_item_list: [{}] },
    { id: "bsc_sablier", chain: "bsc", name: "Sablier", portfolio_item_list: [{}] },
    { id: "app:polymarket", chain: "app:polymarket", name: "Polymarket", portfolio_item_list: [{}] },
  ];
  const bn = [
    {
      id: "arb_usdai",
      chain: "arb",
      name: "USD.AI",
      _assetMonitorSource: "bn-web3",
      portfolio_item_list: [
        {
          stats: { net_usd_value: 17075 },
          _bnPoolCa: "0x0b2b2b2076d95dda7817e785989fe353fe955ef9",
          detail: {
            supply_token_list: [
              { id: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", symbol: "USDai", usd_value: 17075 },
            ],
          },
        },
      ],
    },
  ];
  const merged = mergeBnProtocolsWithPrevious(previous, bn);
  const ids = merged.map((p) => p.id).sort();
  assert.deepEqual(ids, ["app:polymarket", "arb_usdai", "base_merkl", "bsc_sablier"].sort());
  assert.equal(merged.find((p) => p.id === "arb_usdai")._assetMonitorSource, "bn-web3");
  const keys = collectBnDefiTokenKeys(merged);
  assert.ok(keys.has("arb:0x0b2b2b2076d95dda7817e785989fe353fe955ef9"));
  const tokens = [
    { chain: "arb", tokenId: "0x0b2b2b2076d95dda7817e785989fe353fe955ef9", symbol: "sUSDai", valueUsd: 17020 },
    { chain: "arb", tokenId: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", symbol: "USDC", valueUsd: 7 },
  ];
  const stripped = stripDefiReceiptTokens(tokens, keys);
  assert.equal(stripped.length, 1);
  assert.equal(stripped[0].symbol, "USDC");
});
