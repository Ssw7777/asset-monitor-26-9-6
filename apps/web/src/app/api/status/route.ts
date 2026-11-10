import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { hasCronAuthorization } from "@/lib/cron-auth";
import { readLiveStore, countSnapshots } from "@/lib/store";
import { auditTokens } from "@/lib/token-audit";
import { isWalletRefreshEnabled } from "@/lib/wallets";

export const dynamic = "force-dynamic";

/**
 * 轻量状态接口：用来确认「云端定时刷新到底有没有在跑」。
 * 返回时间、数量和汇总余额，不含地址或密钥；
 * 需要登录会话，或通过云端定时任务鉴权。
 */
export async function GET(req: NextRequest) {
  const authorized = (await hasCronAuthorization(req)) || (await isAuthenticated());
  if (!authorized) {
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }

  const state = await readLiveStore();
  const snapshotCount = await countSnapshots();
  const allWallets = state.wallets;
  const wallets = allWallets.filter(isWalletRefreshEnabled);
  const now = Date.now();
  const fiveMinutes = 5 * 60 * 1000;
  const tenMinutes = 10 * 60 * 1000;
  const twentyMinutes = 20 * 60 * 1000;
  const threeHours = 3 * 60 * 60 * 1000;
  const sixHours = 6 * 60 * 60 * 1000;
  const ageMs = (value: string | undefined) => {
    const at = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(at) && at <= now + 60_000 ? Math.max(0, now - at) : Infinity;
  };
  const walletAges = wallets.map(wallet => ageMs(wallet.lastSuccess?.at));
  const protocolAges = wallets.map(wallet => ageMs(state.protocolCache?.[wallet.address.toLowerCase()]?.at));
  const oldestAgeSeconds = (ages: number[]) => {
    const max = ages.length ? Math.max(...ages) : Infinity;
    return Number.isFinite(max) ? Math.ceil(max / 1000) : null;
  };
  const appsFresh = wallets.filter((wallet) => {
    const at = state.protocolCache?.[wallet.address.toLowerCase()]?.appAt;
    const atMs = at ? new Date(at).getTime() : Number.NaN;
    return Number.isFinite(atMs) && atMs <= now + 60_000 && now - atMs <= sixHours;
  }).length;
  const protocolsFresh = wallets.filter((wallet) => {
    const at = state.protocolCache?.[wallet.address.toLowerCase()]?.at;
    const atMs = at ? new Date(at).getTime() : Number.NaN;
    return Number.isFinite(atMs) && atMs <= now + 60_000 && now - atMs <= sixHours;
  }).length;
  const refreshAgeSeconds = state.lastRefresh
    ? Math.max(0, Math.round((Date.now() - new Date(state.lastRefresh).getTime()) / 1000))
    : null;
  return NextResponse.json({
    ok: true,
    now: new Date(now).toISOString(),
    lastRefresh: state.lastRefresh,
    lastWalletObservationAt: state.lastWalletObservationAt ?? null,
    lastFullRefreshAt: state.lastFullRefreshAt ?? null,
    refreshAgeSeconds,
    snapshotCount,
    walletCount: allWallets.length,
    activeWalletCount: wallets.length,
    pausedWalletCount: allWallets.length - wallets.length,
    walletsOver5min: walletAges.filter(age => age > fiveMinutes).length,
    walletsOver10min: walletAges.filter(age => age > tenMinutes).length,
    oldestWalletAgeSeconds: oldestAgeSeconds(walletAges),
    protocolsWithin5min: protocolAges.filter(age => age <= fiveMinutes).length,
    protocolsWithin10min: protocolAges.filter(age => age <= tenMinutes).length,
    oldestProtocolAgeSeconds: oldestAgeSeconds(protocolAges),
    walletsLive: wallets.filter((wallet) => {
      const at = wallet.lastSuccess?.at ?? wallet.lastUpdated;
      const atMs = at ? new Date(at).getTime() : Number.NaN;
      return wallet.status === "ok" && Number.isFinite(atMs) && atMs <= now + 60_000 && now - atMs <= fiveMinutes;
    }).length,
    walletsOver20min: wallets.filter((wallet) => {
      const at = wallet.lastSuccess?.at;
      const atMs = at ? new Date(at).getTime() : Number.NaN;
      return !Number.isFinite(atMs) || atMs > now + 60_000 || now - atMs > twentyMinutes;
    }).length,
    walletsStale: wallets.filter((wallet) => {
      const at = wallet.lastSuccess?.at;
      const atMs = at ? new Date(at).getTime() : Number.NaN;
      return !Number.isFinite(atMs) || atMs > now + 60_000 || now - atMs > threeHours;
    }).length,
    appsFresh,
    appsStale: wallets.length - appsFresh,
    protocolsFresh,
    protocolsStale: wallets.length - protocolsFresh,
    sourceCounts: {
      direct: allWallets.filter((wallet) => wallet.source === "direct").length,
      public: allWallets.filter((wallet) => wallet.source === "public").length,
      publicPartial: allWallets.filter((wallet) => wallet.source === "public-partial").length,
      other: allWallets.filter(
        (wallet) => wallet.source !== "direct" && wallet.source !== "public" && wallet.source !== "public-partial"
      ).length,
    },
    walletsTotalUsd: Math.round(wallets.reduce((sum, wallet) => sum + wallet.balanceUsd, 0) * 100) / 100,
    pausedWalletsTotalUsd: Math.round((allWallets.length - wallets.length ? allWallets.filter(w => !isWalletRefreshEnabled(w)).reduce((sum, wallet) => sum + wallet.balanceUsd, 0) : 0) * 100) / 100,
    zerionDefiNetUsd: Math.round(
      Object.values(state.zerionDefi ?? {}).reduce((sum, entry) => sum + entry.netUsd, 0) * 100
    ) / 100,
    zerionDefiWallets: Object.keys(state.zerionDefi ?? {}).length,
    tokenSource: state.onchainBreakdown?.tokenSource ?? null,
    tokenCount: state.onchainBreakdown?.tokens?.length ?? 0,
    tokenAudit: auditTokens(state, now),
    marketAudit: state.marketAudit??null,
    web3Audit:state.web3Audit??null,
    dappCount: state.onchainBreakdown?.dapps?.length ?? 0,
  });
}
