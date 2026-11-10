import { resolveCexKeys } from "../crypto";
import type { EncryptedSecretsBlob } from "../types";

export type GateAccountId = "gate" | "gate_b" | "gate_c";

export interface ResolvedGateAccount {
  id: GateAccountId;
  label: string;
  apiKey?: string;
  secret?: string;
  missingError: string;
}

const OPTIONAL_ACCOUNTS: Array<{
  id: Exclude<GateAccountId, "gate">;
  label: string;
  keyEnv: string;
  secretEnv: string;
  missingError: string;
  /** Compact form of the temporary manual row this account replaces. */
  stubKey: string;
}> = [
  {
    id: "gate_b",
    label: "Gate B",
    keyEnv: "GATE_B_KEY",
    secretEnv: "GATE_B_SECRET",
    missingError: "Gate B API key/secret not configured",
    stubKey: "gatebgho",
  },
  {
    id: "gate_c",
    label: "Gate C",
    keyEnv: "GATE_C_KEY",
    secretEnv: "GATE_C_SECRET",
    missingError: "Gate C API key/secret not configured",
    stubKey: "gatecgho",
  },
];

function envValue(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Primary Gate uses GATE_API_KEY / GATE_API_SECRET (or encrypted keys).
 * Optional Gate B / Gate C are included only when both env vars are set.
 * A missing pair is skipped; a half-set pair is skipped and warned.
 */
export function resolveGateAccounts(blob?: EncryptedSecretsBlob | null): ResolvedGateAccount[] {
  const personal = resolveCexKeys(blob ?? null).gate;
  const accounts: ResolvedGateAccount[] = [
    {
      id: "gate",
      label: "Gate",
      apiKey: personal.apiKey?.trim() || undefined,
      secret: personal.secret?.trim() || undefined,
      missingError: "Gate API key/secret not configured",
    },
  ];

  for (const item of OPTIONAL_ACCOUNTS) {
    const apiKey = envValue(item.keyEnv);
    const secret = envValue(item.secretEnv);
    if (apiKey && secret) {
      accounts.push({ id: item.id, label: item.label, apiKey, secret, missingError: item.missingError });
      continue;
    }
    if (apiKey || secret) {
      console.warn(`[gate] skipping ${item.label}: set both ${item.keyEnv} and ${item.secretEnv}, or neither`);
    }
  }

  return accounts;
}

export function compactManualName(name: string): string {
  return name.replace(/\s+/g, "").toLowerCase();
}

/**
 * Drop temporary manual rows once the matching Gate account publishes a live
 * total. Failed or unconfigured accounts leave their stub in place.
 */
export function retirePublishedGateStubs<T extends { name: string }>(
  manual: T[],
  accounts: Array<{ id: string; status: string }>
): { manual: T[]; removed: string[] } {
  const keys = new Set<string>();
  for (const account of accounts) {
    if (account.status !== "ok") continue;
    const spec = OPTIONAL_ACCOUNTS.find((item) => item.id === account.id);
    if (spec) keys.add(spec.stubKey);
  }
  if (!keys.size) return { manual, removed: [] };

  const removed: string[] = [];
  const next = manual.filter((item) => {
    const name = String(item.name || "");
    if (!keys.has(compactManualName(name))) return true;
    removed.push(name);
    return false;
  });
  return { manual: next, removed };
}
