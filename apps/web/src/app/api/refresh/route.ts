import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireAuth } from "@/lib/auth";
import { runRefresh, runWalletBatch } from "@/lib/refresh-run";
import { acquireRefreshLease, releaseRefreshLease } from "@/lib/store";

/** Prefer Hong Kong for Binance (US regions are geo-blocked). */
export const preferredRegion = ["hkg1"];
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const searchParams = new URL(req.url).searchParams;
  const mode = searchParams.get("mode") || "full";
  const leaseOwner = req.headers.get("x-idempotency-key") || randomUUID();
  const acquired = await acquireRefreshLease(leaseOwner);
  if (!acquired) {
    return NextResponse.json({ refreshed: false, refreshMode: "skipped", refreshStatus: "partial" }, { status: 202 });
  }
  try {
    // 单地址手动检查：地址管理页的「检查」按钮，立即单独刷新这一个地址（实时读 DeFi）。
    if (mode === "wallet") {
      const walletId = (searchParams.get("walletId") || "").trim();
      if (!walletId) {
        return NextResponse.json({ error: "缺少 walletId" }, { status: 400 });
      }
      const result = await runWalletBatch({ walletIds: [walletId], live: true });
      const checked = result.state.wallets.find((wallet) => wallet.id === walletId) ?? null;
      return NextResponse.json({ ...result.payload, checkedWallet: checked });
    }
    // 手动/打开页面刷新：全部钱包 + DeFi 实时全量读取（live 模式无视 TTL）。
    const result = await runRefresh({ fast: mode === "fast", live: mode !== "fast" });
    return NextResponse.json(result.payload);
  } finally {
    await releaseRefreshLease(leaseOwner);
  }
}
