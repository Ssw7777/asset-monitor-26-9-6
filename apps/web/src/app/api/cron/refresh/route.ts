import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireAuth } from "@/lib/auth";
import { hasCronAuthorization } from "@/lib/cron-auth";
import { runRefresh, runWalletBatch } from "@/lib/refresh-run";
import { acquireRefreshLease, releaseRefreshLease, StoreConflictError } from "@/lib/store";

export const preferredRegion = ["hkg1"];
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 云端定时刷新入口：接受 Vercel Cron 的 CRON_SECRET、指定 GitHub Actions
 * 工作流签发的短期 OIDC Token，或已经登录的浏览器会话。
 */
async function handle(req: NextRequest) {
  if (!(await hasCronAuthorization(req))) {
    const denied = await requireAuth();
    if (denied) return denied;
  }

  /**
   * mode=fast：只刷新交易所 + 写一条快照。
   * mode=wallet-batch：只刷新最多 3 个轮转钱包，不读交易所、不写快照。
   *   - staleMinutes=N：只刷「成功时间超过 N 分钟」的地址（调度器 5 分钟补查批次）。
   *   - walletId=x：只刷指定地址（地址管理页「检查」按钮）。
   * mode=full / auto：兼容页面手动刷新与每日兜底，同样使用安全的小批量钱包预算。
   */
  const searchParams = new URL(req.url).searchParams;
  const mode = searchParams.get("mode") || "auto";
  const walletBudgetParam = searchParams.get("walletBudget");
  const requestedWalletBudget = walletBudgetParam === null ? Number.NaN : Number(walletBudgetParam);
  const walletBudget = Number.isInteger(requestedWalletBudget)
    ? Math.max(1, Math.min(3, requestedWalletBudget))
    : undefined;
  const staleMinutesParam = Number(searchParams.get("staleMinutes"));
  const staleMinutes =
    Number.isInteger(staleMinutesParam) && staleMinutesParam > 0
      ? Math.min(1440, staleMinutesParam)
      : undefined;
  const walletId = (searchParams.get("walletId") || "").trim();
  const live = searchParams.get("live") === "1" || searchParams.get("live") === "true";
  const leaseOwner = req.headers.get("x-idempotency-key") || randomUUID();
  const acquired = await acquireRefreshLease(leaseOwner);
  if (!acquired) {
    return NextResponse.json({ ok: true, mode, ran: "skipped", reason: "refresh_in_progress" }, { status: 202 });
  }

  try {
    const result =
      mode === "fast"
        ? await runRefresh({ fast: true })
        : mode === "wallet-batch"
          ? await runWalletBatch({
              // Carousel: at most 3 wallets per call. Binance Web3 is the total source,
              // so this no longer clamps to 1 to protect Rabby.
              walletBudget: walletBudget ?? 3,
              staleMinutes,
              walletIds: walletId ? [walletId] : undefined,
              live,
            })
        : mode === "full"
          ? await runRefresh({ walletBudget, live })
          : await runRefresh({ auto: true, walletBudget, live });
    const refreshStatus = result.payload.refreshStatus;
    return NextResponse.json(
      {
        ok: refreshStatus !== "failed",
        mode,
        walletBudget: mode === "wallet-batch" ? (walletBudget ?? 3) : (walletBudget ?? 1),
        staleMinutes: staleMinutes ?? null,
        ran: result.payload.refreshMode,
        refreshStatus,
        refreshedAt: new Date().toISOString(),
        walletOk: result.walletOk,
        walletTotal: result.walletTotal,
        batchAttempted: result.batchAttempted,
        batchSucceeded: result.batchSucceeded,
      },
      { status: refreshStatus === "failed" ? 503 : 200 }
    );
  } catch (error) {
    if (error instanceof StoreConflictError) {
      return NextResponse.json(
        { ok: false, mode, reason: "store_conflict", retryable: true },
        { status: 503, headers: { "Retry-After": "2" } }
      );
    }
    throw error;
  } finally {
    await releaseRefreshLease(leaseOwner);
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
