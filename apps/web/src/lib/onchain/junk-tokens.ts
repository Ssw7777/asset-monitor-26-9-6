/**
 * Spam / airdrop names that must not appear in the token list, flows, alerts, or a summed NAV.
 */
const URLISH = /(?:https?:\/\/|www\.|t\.me\/|telegram\.me|\.com\b|\.xyz\b|\.top\b|\.site\b|\.vip\b|\.io\b\/)/i;
const SCAM = /(?:airdrop|claim(?:\s|$)|\bfree mint\b|visit\s|support desk|wallet.?drain|voucher|giveaway|\.eth\b.*claim)/i;

/** Brand-hijack / lookalike tickers seen in phishing airdrops (ASCII). */
const BRAND_HIJACK =
  /^(?:tes.?la|tesiasi|teslas?i|binances?i|okxs?i|metamasks?i|coinbases?i|uniswap.?i)/i;

/**
 * Strip combining marks / zero-widths then ask whether the cleaned form is a
 * stablecoin ticker while the raw symbol was not plain ASCII USDT/USDC/…
 * Homoglyph phishing (ÚSDT, U\u200bSDC, USD₮0) must never price as $1.
 */
function isHomoglyphStable(sym: string): boolean {
  if (!sym) return false;
  if (/^USDT0?$/i.test(sym) || /^USDC$/i.test(sym) || /^USDG$/i.test(sym) || /^USD1$/i.test(sym)) {
    return false; // genuine ASCII stables
  }
  const stripped = sym
    .normalize("NFKD")
    .replace(/[\u0300-\u036f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\uFE00-\uFE0F]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, "")
    .toUpperCase();
  if (!/^(USDT0?|USDC|USDG|USD1|USDE|DAI|USDS|FDUSD|PYUSD)$/.test(stripped)) return false;
  // Raw differed from a clean ASCII stable → homoglyph bait.
  return stripped !== sym.replace(/\s+/g, "").toUpperCase();
}

export function isJunkTokenSymbol(symbol: unknown, extra = ""): boolean {
  const sym = typeof symbol === "string" ? symbol.trim() : "";
  if (!sym) return true;
  const blob = `${sym} ${extra}`.trim();
  if (URLISH.test(blob) || SCAM.test(blob)) return true;
  // Non-ASCII tickers are the usual airdrop bait (homoglyphs, CJK spam, emoji).
  if (/[^\u0000-\u007F]/.test(sym)) return true;
  if (/[\u0000-\u001F\u007F]/.test(sym)) return true;
  if (sym.length > 32) return true;
  if (/[|{}<>]/.test(sym) || /\s{2,}/.test(sym)) return true;
  if (BRAND_HIJACK.test(sym.replace(/\s+/g, ""))) return true;
  if (isHomoglyphStable(sym)) return true;
  return false;
}

/** Dust that should not be listed. Does not change a provider wallet total. */
export function isDustTokenValue(valueUsd: unknown, minUsd = 0.05): boolean {
  const value = Number(valueUsd);
  return Number.isFinite(value) && value >= 0 && value < minUsd;
}

/** Known fake / airdrop-scam token contracts (lowercase), any chain. */
export const FAKE_TOKEN_CONTRACTS = new Set<string>([
  // Robinhood Chain: fake "USDG / United States Global Dollar" (18 decimals), mass-airdropped
  // 10 tokens to 500 addresses in tx 0xc6d68d13…28b2. Real USDG is 0x5fc5…d168 (6 decimals).
  "0xbf6295d125b61178ab182bb63875b7fc2d607a70",
]);

/** Canonical contracts for stable tickers on chains where we know them; other contracts using that ticker are fakes. */
const CANONICAL_STABLES: Record<string, Record<string, string[]>> = {
  hood: { USDG: ["0x5fc5360d0400a0fd4f2af552add042d716f1d168"] },
  eth: { USDG: ["0xe343167631d89b6ffc58b88d6b7fb0228795491d"] },
};

export function isFakeTokenContract(chain: unknown, symbol: unknown, contract: unknown): boolean {
  const c = typeof contract === "string" ? contract.trim().toLowerCase() : "";
  if (!c) return false;
  if (FAKE_TOKEN_CONTRACTS.has(c)) return true;
  const sym = typeof symbol === "string" ? symbol.trim().toUpperCase() : "";
  const allowed = CANONICAL_STABLES[String(chain || "").toLowerCase()]?.[sym];
  return Boolean(allowed && !allowed.includes(c));
}
