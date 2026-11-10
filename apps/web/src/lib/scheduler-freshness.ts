/** Query before the five-minute wallet-total freshness boundary; never relabel old cache as live. */
export const PROTOCOL_REFRESH_LEAD_MS = 3.5 * 60 * 1000;

export function needsProtocolRefresh(at: string | undefined, now: number): boolean {
  const observed = at ? Date.parse(at) : Number.NaN;
  return !Number.isFinite(observed) || observed > now + 60_000 || observed < now - PROTOCOL_REFRESH_LEAD_MS;
}
