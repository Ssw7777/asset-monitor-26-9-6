import type { Wallet } from "./types";
import { isWalletRefreshEnabled } from "./wallets";

type FreshnessWallet = Pick<Wallet, "status" | "lastSuccess"> &
  Partial<Pick<Wallet, "address" | "refreshPaused">>;

/** Freshness only counts wallets still in the refresh queue (excludes paused Abstract). */
export function walletFreshness(wallets: FreshnessWallet[], now = Date.now()) {
  const active = wallets.filter((wallet) => {
    if (wallet.refreshPaused === true) return false;
    if (!wallet.address) return true;
    return isWalletRefreshEnabled({
      address: wallet.address,
      refreshPaused: wallet.refreshPaused,
    });
  });
  const ages = active.map((wallet) => {
    const at = Date.parse(wallet.lastSuccess?.at ?? "");
    return Number.isFinite(at) && at <= now + 60_000 ? Math.max(0, now - at) : Infinity;
  });
  const fresh = active.filter((wallet, index) => wallet.status === "ok" && ages[index] <= 300_000).length;
  const oldestAgeMs = ages.length ? Math.max(...ages) : Infinity;
  return { fresh, total: active.length, stale: active.length - fresh, oldestAgeMs };
}
