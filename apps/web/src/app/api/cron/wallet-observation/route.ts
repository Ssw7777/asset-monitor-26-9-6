import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { hasCronAuthorization } from "@/lib/cron-auth";
import {
  ingestWalletObservations,
  UnknownWalletObservationError,
  WalletObservationValidationError,
  type WalletObservationInput,
} from "@/lib/refresh-run";
import { acquireRefreshLease, releaseRefreshLease } from "@/lib/store";

export const preferredRegion = ["hkg1"];
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_OBSERVATIONS = 10;

function parseRequestEntry(
  raw: unknown,
  requireObservedAt: boolean
): WalletObservationInput | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const address = typeof record.address === "string" ? record.address.trim() : "";
  const suppliedObservedAt =
    typeof record.observedAt === "string" ? record.observedAt.trim() : "";
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  if (requireObservedAt && !suppliedObservedAt) return null;
  if (suppliedObservedAt && !Number.isFinite(new Date(suppliedObservedAt).getTime())) return null;
  if (!("observation" in record)) return null;
  // The currently deployed legacy scheduler sends a single observation without
  // `observedAt`. Keep that transition path until the batch workflow is live.
  const observedAt = suppliedObservedAt || new Date().toISOString();
  return {
    address,
    observedAt,
    observation: record.observation,
    ...(Object.prototype.hasOwnProperty.call(record, "tokenObservations") ? { tokenObservations: record.tokenObservations as WalletObservationInput["tokenObservations"] } : {}),
    ...(Object.prototype.hasOwnProperty.call(record, "tokenSpecificObservations") ? { tokenSpecificObservations: record.tokenSpecificObservations as WalletObservationInput["tokenSpecificObservations"] } : {}),
    ...(Object.prototype.hasOwnProperty.call(record, "appObservation")
      ? { appObservation: record.appObservation }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(record, "protocolObservation")
      ? { protocolObservation: record.protocolObservation }
      : {}),
  };
}

function retryableError(error: string) {
  return NextResponse.json(
    { ok: false, retryable: true, error },
    { status: 503, headers: { "Retry-After": "2" } }
  );
}

export async function POST(req: NextRequest) {
  if (!(await hasCronAuthorization(req))) {
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "无效 JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "无效请求" }, { status: 400 });
  }
  const record = body as Record<string, unknown>;
  const isBatch = Object.prototype.hasOwnProperty.call(record, "observations");
  let observations: WalletObservationInput[];
  if (isBatch) {
    if (
      !Array.isArray(record.observations) ||
      record.observations.length < 1 ||
      record.observations.length > MAX_OBSERVATIONS
    ) {
      return NextResponse.json({ error: "观测批次必须包含 1-10 条数据" }, { status: 400 });
    }
    const parsed = record.observations.map((entry) => parseRequestEntry(entry, true));
    if (parsed.some((entry) => entry === null)) {
      return NextResponse.json({ error: "观测批次格式无效" }, { status: 400 });
    }
    observations = parsed as WalletObservationInput[];
  } else {
    const parsed = parseRequestEntry(record, false);
    if (!parsed) {
      return NextResponse.json({ error: "钱包观测格式无效" }, { status: 400 });
    }
    observations = [parsed];
  }

  const leaseOwner = req.headers.get("x-idempotency-key") || randomUUID();
  if (!(await acquireRefreshLease(leaseOwner, 45_000))) {
    return retryableError("refresh_in_progress");
  }

  try {
    const result = await ingestWalletObservations(observations);
    return NextResponse.json({
      ok: true,
      ran: isBatch ? "wallet-observations" : "wallet-observation",
      refreshStatus: result.payload.refreshStatus,
      walletOk: result.walletOk,
      walletTotal: result.walletTotal,
      batchAttempted: result.batchAttempted,
      batchSucceeded: result.batchSucceeded,
      skipped: result.payload.skipped,
      appRefreshed: result.payload.appRefreshed,
      protocolsRefreshed: result.payload.protocolsRefreshed,
      tokensRefreshed: result.payload.tokensRefreshed,
    });
  } catch (error) {
    console.error("[cron] wallet observation rejected", error);
    if (error instanceof WalletObservationValidationError) {
      return NextResponse.json({ error: "余额数据无效" }, { status: 422 });
    }
    if (error instanceof UnknownWalletObservationError) {
      return NextResponse.json({ error: "地址不在配置中" }, { status: 404 });
    }
    return retryableError("wallet_observation_persistence_failed");
  } finally {
    await releaseRefreshLease(leaseOwner);
  }
}
