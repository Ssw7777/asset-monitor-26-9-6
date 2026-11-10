import test from "node:test";
import assert from "node:assert/strict";
import { exchangeIconId, exchangeLabel } from "../src/lib/exchange-labels.ts";
import { compactManualName, resolveGateAccounts, retirePublishedGateStubs } from "../src/lib/cex/gate-accounts.ts";
import {
  GATE_TOTAL_BALANCE_PATH,
  fetchConfiguredGateAccounts,
  gateEquityUsd,
} from "../src/lib/cex/balances.ts";
import { detectFlowEventsBetween } from "../src/lib/flows.ts";
import { buildChangeSummary } from "../src/lib/changes.ts";

const ENV_NAMES = [
  "GATE_API_KEY",
  "GATE_API_SECRET",
  "GATE_B_KEY",
  "GATE_B_SECRET",
  "GATE_C_KEY",
  "GATE_C_SECRET",
];

function snapshotEnv() {
  return Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
}

function restoreEnv(saved) {
  for (const name of ENV_NAMES) {
    if (saved[name] == null) delete process.env[name];
    else process.env[name] = saved[name];
  }
}

function clearGateEnv() {
  for (const name of ENV_NAMES) delete process.env[name];
}

test("gate equity adds unrealised pnl and subtracts borrowed", () => {
  const equity = gateEquityUsd({ total: { amount: "100.5", unrealised_pnl: "1.25", borrowed: "0.5" } });
  assert.equal(equity.ok, true);
  assert.equal(equity.balanceUsd, 101.25);
  assert.equal(gateEquityUsd({ total: { amount: "nope" } }).ok, false);
  assert.equal(gateEquityUsd({}).ok, false);
});

test("missing Gate B and Gate C env skips those accounts and does not call Gate", async () => {
  const saved = snapshotEnv();
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error("fetch should not run");
  };
  try {
    clearGateEnv();
    const accounts = resolveGateAccounts(null);
    assert.deepEqual(accounts.map((account) => account.id), ["gate"]);
    const rows = await fetchConfiguredGateAccounts(null);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "missing_keys");
    assert.equal(calls, 0);
  } finally {
    global.fetch = original;
    restoreEnv(saved);
  }
});

test("a half-set optional pair is skipped without throwing or logging the secret", () => {
  const saved = snapshotEnv();
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    clearGateEnv();
    process.env.GATE_B_KEY = "b-key-should-not-be-logged";
    process.env.GATE_C_SECRET = "   ";
    const accounts = resolveGateAccounts(null);
    assert.deepEqual(accounts.map((account) => account.id), ["gate"]);
    const text = warnings.join("\n");
    assert.match(text, /GATE_B_KEY/);
    assert.match(text, /GATE_B_SECRET/);
    assert.doesNotMatch(text, /b-key-should-not-be-logged/);
  } finally {
    console.warn = original;
    restoreEnv(saved);
  }
});

test("three configured accounts are fetched read-only and summed", async () => {
  const saved = snapshotEnv();
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    const headers = init?.headers ?? {};
    const key = headers.KEY ?? headers.get?.("KEY");
    calls.push({ url: String(url), method: init?.method || "GET", key });
    if (key === "b-key") {
      return new Response(JSON.stringify({ label: "INVALID_KEY", message: "nope" }), { status: 401 });
    }
    const amount = key === "c-key" ? "30.1" : "10";
    const body = { total: { amount, unrealised_pnl: key === "personal-key" ? "0.2" : "0", borrowed: "0" } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    clearGateEnv();
    process.env.GATE_API_KEY = " personal-key ";
    process.env.GATE_API_SECRET = "personal-secret";
    process.env.GATE_B_KEY = "b-key";
    process.env.GATE_B_SECRET = "b-secret";
    process.env.GATE_C_KEY = "c-key";
    process.env.GATE_C_SECRET = "c-secret";

    const rows = await fetchConfiguredGateAccounts(null);
    assert.deepEqual(
      rows.map((row) => row.id),
      ["gate", "gate_b", "gate_c"]
    );
    assert.equal(rows.find((row) => row.id === "gate").status, "ok");
    assert.equal(rows.find((row) => row.id === "gate").balanceUsd, 10.2);
    assert.equal(rows.find((row) => row.id === "gate_b").status, "error");
    assert.equal(rows.find((row) => row.id === "gate_c").status, "ok");
    assert.equal(rows.find((row) => row.id === "gate_c").balanceUsd, 30.1);
    assert.match(rows.find((row) => row.id === "gate_b").error, /INVALID_KEY|nope|401|total_balance/);
    assert.doesNotMatch(rows.find((row) => row.id === "gate_b").error, /b-secret/);

    const live = rows.filter((row) => row.status === "ok").reduce((sum, row) => sum + row.balanceUsd, 0);
    assert.equal(Math.round(live * 100) / 100, 40.3);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.method, "GET");
      assert.equal(call.url, `https://api.gateio.ws${GATE_TOTAL_BALANCE_PATH}?currency=USDT`);
    }
    assert.deepEqual(calls.map((call) => call.key).sort(), ["b-key", "c-key", "personal-key"]);
  } finally {
    global.fetch = original;
    restoreEnv(saved);
  }
});

test("published Gate B/C balances retire only their manual GHO stubs", () => {
  const manual = [
    { id: "a", name: "Gate B GHO" },
    { id: "b", name: "Gate  C   GHO" },
    { id: "c", name: "Other OKX account" },
  ];
  assert.equal(compactManualName("Gate B GHO"), "gatebgho");
  const held = retirePublishedGateStubs(manual, [
    { id: "gate_b", status: "error" },
    { id: "gate_c", status: "missing_keys" },
  ]);
  assert.equal(held.removed.length, 0);
  assert.equal(held.manual.length, 3);

  const bOnly = retirePublishedGateStubs(manual, [
    { id: "gate_b", status: "ok" },
    { id: "gate_c", status: "error" },
  ]);
  assert.deepEqual(bOnly.removed, ["Gate B GHO"]);
  assert.deepEqual(
    bOnly.manual.map((item) => item.id),
    ["b", "c"]
  );

  const both = retirePublishedGateStubs(manual, [
    { id: "gate", status: "ok" },
    { id: "gate_b", status: "ok" },
    { id: "gate_c", status: "ok" },
  ]);
  assert.deepEqual(
    both.manual.map((item) => item.name),
    ["Other OKX account"]
  );
});

test("moving a stub onto a new Gate row is not booked as a flow", () => {
  const address = "0x" + "ab".repeat(20);
  const state = { wallets: [{ address, name: "A" }] };
  const prev = {
    ts: new Date(Date.now() - 60_000).toISOString(),
    wallets: { [address]: 10 },
    manualItems: { "Gate B GHO": 500 },
    exchanges: { gate: 10 },
  };
  const cur = {
    ts: new Date().toISOString(),
    wallets: { [address]: 10 },
    manualItems: {},
    exchanges: { gate: 10, gate_b: 480 },
    suppressManualFlows: ["Gate B GHO"],
    suppressExchangeFlows: ["gate_b"],
  };
  assert.equal(detectFlowEventsBetween(state, prev, cur).length, 0);

  const raw = detectFlowEventsBetween(state, prev, {
    ...cur,
    suppressManualFlows: undefined,
    suppressExchangeFlows: undefined,
  });
  assert.equal(raw.some((event) => event.entityLabel === "Gate B GHO"), false);
  assert.ok(raw.some((event) => event.entityLabel === "Gate B" && event.direction === "in"));

  const explicitZero = detectFlowEventsBetween(state, prev, {
    ...cur,
    manualItems: { "Gate B GHO": 0 },
    suppressManualFlows: undefined,
    suppressExchangeFlows: ["gate_b"],
  });
  assert.ok(explicitZero.some((event) => event.entityLabel === "Gate B GHO" && event.direction === "out"));
  const suppressedZero = detectFlowEventsBetween(state, prev, {
    ...cur,
    manualItems: { "Gate B GHO": 0 },
    suppressExchangeFlows: ["gate_b"],
  });
  assert.equal(suppressedZero.length, 0);
});

test("a new Gate B/C row is a baseline in the change panel", () => {
  const now = Date.now();
  const past = new Date(now - 60 * 60 * 1000).toISOString();
  const latest = new Date(now).toISOString();
  const summary = buildChangeSummary(
    {
      manual: [],
      wallets: [],
      exchanges: [
        { exchange: "gate", balanceUsd: 12, status: "ok", lastUpdated: latest },
        { exchange: "gate_b", balanceUsd: 480, status: "ok", lastUpdated: latest },
        { exchange: "gate_c", balanceUsd: 90, status: "ok", lastUpdated: latest },
      ],
      snapshots: [
        { ts: past, totalUsd: 10, exchanges: { gate: 10 } },
        { ts: latest, totalUsd: 582, exchanges: { gate: 12, gate_b: 480, gate_c: 90 } },
      ],
    },
    "1h",
    { now: now + 1000 }
  );
  const keys = summary.rows.filter((row) => row.type === "exchange").map((row) => row.key);
  assert.deepEqual(keys, ["exchange:gate"]);
  assert.equal(summary.rows.find((row) => row.key === "exchange:gate").label, "Gate");
  assert.equal(exchangeLabel("gate_b"), "Gate B");
  assert.equal(exchangeLabel("gate_c"), "Gate C");
  assert.equal(exchangeIconId("gate_b"), "gate");
  assert.equal(exchangeIconId("gate_c"), "gate");
});
