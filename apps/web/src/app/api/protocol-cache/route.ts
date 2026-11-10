import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { refreshOnchainBreakdown } from "@/lib/onchain/debank";
import { mutateStore } from "@/lib/store";

export const preferredRegion = ["hkg1"];
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const tokenSchema = z.object({
  role: z.enum(["supply", "asset", "borrow", "debt", "reward"]),
  symbol: z.string().min(1).max(80),
  amount: z.number().finite(),
  price: z.number().finite().nonnegative(),
  usdValue: z.number().finite().nonnegative(),
});

const positionSchema = z.object({
  assetUsdValue: z.number().finite().nonnegative(),
  debtUsdValue: z.number().finite().nonnegative(),
  netUsdValue: z.number().finite(),
  tokens: z.array(tokenSchema).max(100),
});

const protocolSchema = z.object({
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(160),
  chain: z.string().min(1).max(80),
  siteUrl: z.string().max(500).optional().default(""),
  logoUrl: z.string().max(1000).optional(),
  positions: z.array(positionSchema).max(100),
});

const bodySchema = z.object({
  auditedAt: z.string().datetime(),
  mergeProtocols: z.boolean().optional().default(false),
  wallets: z
    .array(
      z.object({
        address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        protocols: z.array(protocolSchema).max(100),
      })
    )
    .max(50),
});

function rawToken(token: z.infer<typeof tokenSchema>) {
  return {
    optimized_symbol: token.symbol,
    amount: token.amount,
    price: token.price,
    usd_value: token.usdValue,
  };
}

/** Import a trusted full-wallet protocol audit into the server-side persistent cache. */
export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_protocol_audit" }, { status: 400 });
  }

  const mutation = await mutateStore(async (state) => {
    const known = new Set(state.wallets.map((wallet) => wallet.address.toLowerCase()));
    const cache = { ...(state.protocolCache ?? {}) };
    let importedWallets = 0;

    for (const wallet of parsed.data.wallets) {
      const address = wallet.address.toLowerCase();
      if (!known.has(address)) continue;
      const currentAtMs = cache[address]?.at ? new Date(cache[address].at).getTime() : Number.NaN;
      const incomingAtMs = new Date(parsed.data.auditedAt).getTime();
      if (Number.isFinite(currentAtMs) && currentAtMs >= incomingAtMs) continue;
      const importedProtocols = wallet.protocols.map((protocol) => ({
        id: protocol.id,
        name: protocol.name,
        chain: protocol.chain,
        site_url: protocol.siteUrl,
        logo_url: protocol.logoUrl,
        portfolio_item_list: protocol.positions.map((position) => ({
          stats: {
            asset_usd_value: position.assetUsdValue,
            debt_usd_value: position.debtUsdValue,
            net_usd_value: position.netUsdValue,
          },
          detail: {
            supply_token_list: position.tokens
              .filter((token) => token.role === "supply" || token.role === "asset")
              .map(rawToken),
            borrow_token_list: position.tokens
              .filter((token) => token.role === "borrow" || token.role === "debt")
              .map(rawToken),
            reward_token_list: position.tokens.filter((token) => token.role === "reward").map(rawToken),
          },
        })),
      }));
      const importedIds = new Set(importedProtocols.map((protocol) => protocol.id.toLowerCase()));
      const retainedProtocols = parsed.data.mergeProtocols
        ? (cache[address]?.protocols ?? []).filter(
            (protocol) => !importedIds.has(String(protocol.id ?? "").toLowerCase())
          )
        : [];
      cache[address] = {
        ...(cache[address] ?? {}),
        at: parsed.data.auditedAt,
        lastAttemptAt: parsed.data.auditedAt,
        protocols: [...retainedProtocols, ...importedProtocols],
      };
      importedWallets += 1;
    }

    const breakdown = await refreshOnchainBreakdown(
      state.wallets,
      state.chainCache ?? {},
      state.tokenCache ?? {},
      cache,
      state.zerionDefi ?? {}
    );
    state.protocolCache = cache;
    state.onchainBreakdown = breakdown;
    return { importedWallets, breakdown };
  });
  const { importedWallets, breakdown } = mutation.result;
  const kona = breakdown.dapps.find((dapp) => dapp.name.toLowerCase() === "kona");

  return NextResponse.json({
    ok: true,
    importedWallets,
    dapps: breakdown.dapps.length,
    konaWallets: kona?.wallets.length ?? 0,
    konaNetUsd: kona?.netUsd ?? 0,
  });
}
