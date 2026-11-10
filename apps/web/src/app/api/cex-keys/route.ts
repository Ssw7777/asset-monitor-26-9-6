import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { canEncrypt, encryptJson, decryptJson } from "@/lib/crypto";
import { publicState, readStore, setEncryptedSecrets } from "@/lib/store";
import type { CexKeyMaterial } from "@/lib/types";

/** Status only — never return secret material */
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  const s = await readStore();
  let configured: Record<string, boolean> = { okx: false, binance: false, gate: false, bitget: false };
  if (s.encryptedSecrets && canEncrypt()) {
    try {
      const m = decryptJson(s.encryptedSecrets);
      configured = {
        okx: !!(m.okx?.apiKey && m.okx?.apiSecret && m.okx?.passphrase),
        binance: !!(m.binance?.apiKey && m.binance?.apiSecret),
        gate: !!(m.gate?.apiKey && m.gate?.apiSecret),
        bitget: !!(m.bitget?.apiKey && m.bitget?.apiSecret && m.bitget?.passphrase),
      };
    } catch {
      /* ignore */
    }
  }
  return NextResponse.json({
    encryptionReady: canEncrypt(),
    hasEncryptedSecrets: !!s.encryptedSecrets,
    configured,
    envConfigured: {
      okx: !!(process.env.OKX_API_KEY && process.env.OKX_API_SECRET && process.env.OKX_API_PASSPHRASE),
      binance: !!(process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET),
      gate: !!(process.env.GATE_API_KEY && process.env.GATE_API_SECRET),
      gateB: !!(process.env.GATE_B_KEY?.trim() && process.env.GATE_B_SECRET?.trim()),
      gateC: !!(process.env.GATE_C_KEY?.trim() && process.env.GATE_C_SECRET?.trim()),
      bitget: !!(process.env.BITGET_API_KEY && process.env.BITGET_API_SECRET && process.env.BITGET_API_PASSPHRASE),
    },
  });
}

/** Save/update encrypted key material (auth required). Never echoes secrets back. */
export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  if (!canEncrypt()) {
    return NextResponse.json(
      { error: "未配置 ENCRYPTION_KEY，无法加密存储密钥" },
      { status: 400 }
    );
  }
  const body = await req.json();
  const s = await readStore();
  let existing: CexKeyMaterial = {};
  if (s.encryptedSecrets) {
    try {
      existing = decryptJson(s.encryptedSecrets);
    } catch {
      existing = {};
    }
  }

  const merge = (prev: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined) => {
    if (!next) return prev;
    const out = { ...(prev || {}) };
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "") {
        delete (out as Record<string, unknown>)[k];
      } else if (v !== undefined) {
        (out as Record<string, unknown>)[k] = v;
      }
    }
    return out;
  };

  const merged: CexKeyMaterial = {
    okx: merge(existing.okx as Record<string, unknown> | undefined, body.okx) as CexKeyMaterial["okx"],
    binance: merge(
      existing.binance as Record<string, unknown> | undefined,
      body.binance
    ) as CexKeyMaterial["binance"],
    gate: merge(existing.gate as Record<string, unknown> | undefined, body.gate) as CexKeyMaterial["gate"],
    bitget: merge(
      existing.bitget as Record<string, unknown> | undefined,
      body.bitget
    ) as CexKeyMaterial["bitget"],
  };

  if (body.clear === true) {
    await setEncryptedSecrets(null);
    const after = await readStore();
    return NextResponse.json({ ok: true, cleared: true, ...publicState(after) });
  }

  const blob = encryptJson(merged);
  await setEncryptedSecrets(blob);
  const after = await readStore();
  return NextResponse.json({
    ok: true,
    hasEncryptedSecrets: true,
    encryptionReady: true,
    updatedAt: blob.updatedAt,
    // never return ciphertext or plaintext keys
  });
}

export async function DELETE() {
  const denied = await requireAuth();
  if (denied) return denied;
  await setEncryptedSecrets(null);
  return NextResponse.json({ ok: true, cleared: true });
}
