import { NextRequest, NextResponse } from "next/server";
import { hasCronAuthorization } from "@/lib/cron-auth";
import { readStore } from "@/lib/store";
import { needsProtocolRefresh } from "@/lib/scheduler-freshness";
import { requiredTokenChains } from "@/lib/token-audit";
import { tokenUuid } from "@/lib/onchain/rabby-token-observation";
import { isWalletRefreshEnabled } from "@/lib/wallets";

export const preferredRegion = ["hkg1"];
export const dynamic = "force-dynamic";

/**
 * Private scheduler manifest. Addresses are returned only to an authenticated
 * GitHub-hosted runner and are never embedded in the public workflow source.
 */
export async function GET(req: NextRequest) {
  if (!(await hasCronAuthorization(req))) {
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }

  const state = await readStore();
  // Preserve storage order for compatibility. The single-runner collector freezes
  // this manifest once and schedules oldest successful observations first.
  const now = Date.now();
  const retryBefore = now - 8 * 60 * 1000;
  // App audits consume a limited authenticated quota. Keep that separate from
  // public protocol positions, which must follow the ten-minute wallet cadence.
  const detailRefreshBefore = now - 5.5 * 60 * 60 * 1000;
  const activeWallets = state.wallets.filter(isWalletRefreshEnabled);
  const appRefreshIndexes = new Set(
    activeWallets
    .map((wallet, index) => {
      const rawAt = state.protocolCache?.[wallet.address.toLowerCase()]?.appAt;
      const parsedAt = rawAt ? new Date(rawAt).getTime() : Number.NaN;
      const validAt = Number.isFinite(parsedAt) && parsedAt <= now + 60_000 ? parsedAt : 0;
      return { index, at: validAt };
    })
    .filter((entry) => entry.at < detailRefreshBefore)
      .sort((left, right) => left.at - right.at || left.index - right.index)
      .slice(0, 10)
      .map((entry) => entry.index)
  );
  const protocolRefreshIndexes = new Set(
    activeWallets
      .map((wallet, index) => {
        const rawAt = state.protocolCache?.[wallet.address.toLowerCase()]?.at;
        return { index, due: needsProtocolRefresh(rawAt, now) };
      })
      .filter((entry) => entry.due)
      .map((entry) => entry.index)
  );
  const wallets = activeWallets.map((wallet, index) => {
    const key = wallet.address.toLowerCase();
    const tokens = state.tokenCache?.[key];
    const tokenChains = requiredTokenChains(state, key).map(chain => ({
      chain, at: Date.parse(tokens?.chainUpdatedAt?.[chain] ?? tokens?.at ?? "") || 0,
      value: state.chainCache?.[key]?.chains.find(item => item.id === chain)?.valueUsd ?? 0,
    })).sort((a,b) => a.at - b.at || b.value - a.value).map(item => item.chain);
    const needsTokenRefresh = tokenChains.some(chain => {
      const at = Date.parse(tokens?.chainUpdatedAt?.[chain] ?? tokens?.at ?? "");
      return !Number.isFinite(at) || at > now + 60_000 || now - at > 8 * 60_000 || !!tokens?.chainErrors?.[chain];
    });
    const lastSuccessMs = wallet.lastSuccess?.at
      ? new Date(wallet.lastSuccess.at).getTime()
      : Number.NaN;
    return {
      id: wallet.id,
      address: wallet.address.toLowerCase(),
      lastSuccessAt: wallet.lastSuccess?.at ?? null,
      protocolUpdatedAt: state.protocolCache?.[key]?.at ?? null,
      tokenAttemptAt: tokens?.lastAttemptAt ?? null,
      tokenDiscoveryAt: Object.values(tokens?.chainAttemptAt ?? {})
        .filter(at => Number.isFinite(Date.parse(at)))
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null,
      needsRetry:
        !Number.isFinite(lastSuccessMs) ||
        lastSuccessMs > now + 60_000 ||
        lastSuccessMs < retryBefore || protocolRefreshIndexes.has(index),
      needsAppRefresh: appRefreshIndexes.has(index),
      needsProtocolRefresh: protocolRefreshIndexes.has(index),
      needsTokenRefresh,
      tokenChains,
      tokenUuids: [...new Set([...(tokens?.tokens ?? []).map(tokenUuid).filter((id): id is string => !!id), ...Object.keys(tokens?.inventory ?? {})])]
        .sort((a,b) => (Date.parse(tokens?.tokenAttemptAt?.[a] ?? tokens?.inventory?.[a]?.updatedAt ?? "") || 0) - (Date.parse(tokens?.tokenAttemptAt?.[b] ?? tokens?.inventory?.[b]?.updatedAt ?? "") || 0)),
    };
  });

  return NextResponse.json({ ok: true, count: wallets.length, wallets });
}
