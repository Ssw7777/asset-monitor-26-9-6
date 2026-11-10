import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { computeTotals, publicState, readStore, updateWallets } from "@/lib/store";
import type { ChainType, Wallet } from "@/lib/types";
import {
  WALLET_LIMIT,
  ensureAbstractName,
  findDupeIndex,
  isValidEthAddress,
  makeWallet,
  parseBatchAddresses,
} from "@/lib/wallets";

async function okPayload() {
  const s = await readStore();
  return {
    ...publicState(s),
    wallets: s.wallets,
    totals: computeTotals(s),
    limit: WALLET_LIMIT,
  };
}

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  const s = await readStore();
  return NextResponse.json({
    wallets: s.wallets,
    totals: computeTotals(s),
    limit: WALLET_LIMIT,
  });
}

/** Create or update a single wallet */
export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  const body = await req.json();
  const action = String(body.action || "upsert");

  const s = await readStore();
  let wallets = [...s.wallets];

  if (action === "batch") {
    const chain = (body.chain === "ABSTRACT" ? "ABSTRACT" : "EVM") as ChainType;
    const text = String(body.text || "");
    const addrs = parseBatchAddresses(text);
    if (!addrs.length) {
      return NextResponse.json({ error: "未解析到有效地址" }, { status: 400 });
    }
    let added = 0;
    let skipped = 0;
    for (const addr of addrs) {
      if (wallets.length >= WALLET_LIMIT) break;
      if (findDupeIndex(wallets, addr) >= 0) {
        skipped++;
        continue;
      }
      const baseName = String(body.namePrefix || `Wallet${wallets.length + 1}`);
      wallets.push(
        makeWallet({
          name: `${baseName}${added + 1}`,
          address: addr,
          chain,
        })
      );
      added++;
    }
    await updateWallets(wallets);
    const payload = await okPayload();
    return NextResponse.json({ ...payload, added, skipped });
  }

  if (action === "delete") {
    const id = String(body.id || "");
    if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
    wallets = wallets.filter((w) => w.id !== id);
    await updateWallets(wallets);
    return NextResponse.json(await okPayload());
  }

  // upsert
  const address = String(body.address || "").trim();
  if (!isValidEthAddress(address)) {
    return NextResponse.json({ error: "地址格式无效（需 0x + 40 hex）" }, { status: 400 });
  }
  const chain = (body.chain === "ABSTRACT" ? "ABSTRACT" : "EVM") as ChainType;
  const name = ensureAbstractName(String(body.name || "未命名"), chain);
  const id = body.id ? String(body.id) : undefined;

  const dupe = findDupeIndex(wallets, address, id);
  if (dupe >= 0) {
    return NextResponse.json({ error: "地址已存在（不区分大小写）" }, { status: 409 });
  }

  if (id) {
    const idx = wallets.findIndex((w) => w.id === id);
    if (idx < 0) return NextResponse.json({ error: "钱包不存在" }, { status: 404 });
    const prev = wallets[idx];
    wallets[idx] = {
      ...prev,
      name,
      address,
      chain,
      // keep balance unless explicitly provided
      balanceUsd:
        body.balanceUsd != null ? Math.round(Number(body.balanceUsd) * 100) / 100 : prev.balanceUsd,
    };
  } else {
    if (wallets.length >= WALLET_LIMIT) {
      return NextResponse.json({ error: `最多 ${WALLET_LIMIT} 个钱包` }, { status: 400 });
    }
    wallets.push(makeWallet({ name, address, chain, balanceUsd: Number(body.balanceUsd) || 0 }));
  }

  const requestedBalance = body.balanceUsd != null ? Number(body.balanceUsd) : Number.NaN;
  await updateWallets(wallets, {
    balanceOverrides:
      id && Number.isFinite(requestedBalance)
        ? { [id]: Math.round(requestedBalance * 100) / 100 }
        : undefined,
  });
  return NextResponse.json(await okPayload());
}

export async function PUT(req: NextRequest) {
  return POST(req);
}

export async function DELETE(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  const s = await readStore();
  const wallets = s.wallets.filter((w: Wallet) => w.id !== id);
  await updateWallets(wallets);
  return NextResponse.json(await okPayload());
}
