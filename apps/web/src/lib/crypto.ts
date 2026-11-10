import crypto from "crypto";
import type { CexKeyMaterial, EncryptedSecretsBlob } from "./types";

function deriveKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || !raw.trim()) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  return crypto.createHash("sha256").update(raw).digest();
}

export function canEncrypt(): boolean {
  return !!deriveKey();
}

export function encryptJson(obj: CexKeyMaterial): EncryptedSecretsBlob {
  const key = deriveKey();
  if (!key) throw new Error("ENCRYPTION_KEY not set");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    updatedAt: new Date().toISOString(),
  };
}

export function decryptJson(blob: EncryptedSecretsBlob): CexKeyMaterial {
  const key = deriveKey();
  if (!key) throw new Error("ENCRYPTION_KEY not set");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(blob.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(dec.toString("utf8")) as CexKeyMaterial;
}

export function resolveCexKeys(blob: EncryptedSecretsBlob | null | undefined): {
  okx: { apiKey?: string; secret?: string; passphrase?: string; simulated: boolean };
  binance: { apiKey?: string; secret?: string };
  gate: { apiKey?: string; secret?: string };
  bitget: { apiKey?: string; secret?: string; passphrase?: string };
  hasEncrypted: boolean;
} {
  let stored: CexKeyMaterial = {};
  if (blob && canEncrypt()) {
    try {
      stored = decryptJson(blob);
    } catch {
      stored = {};
    }
  }
  return {
    okx: {
      apiKey: process.env.OKX_API_KEY || stored.okx?.apiKey,
      secret: process.env.OKX_API_SECRET || stored.okx?.apiSecret,
      passphrase: process.env.OKX_API_PASSPHRASE || stored.okx?.passphrase,
      simulated: process.env.OKX_SIMULATED === "1" || stored.okx?.simulated === true,
    },
    binance: {
      apiKey: process.env.BINANCE_API_KEY || stored.binance?.apiKey,
      secret: process.env.BINANCE_API_SECRET || stored.binance?.apiSecret,
    },
    gate: {
      apiKey: process.env.GATE_API_KEY || stored.gate?.apiKey,
      secret: process.env.GATE_API_SECRET || stored.gate?.apiSecret,
    },
    bitget: {
      apiKey: process.env.BITGET_API_KEY || stored.bitget?.apiKey,
      secret: process.env.BITGET_API_SECRET || stored.bitget?.apiSecret,
      passphrase: process.env.BITGET_API_PASSPHRASE || stored.bitget?.passphrase,
    },
    hasEncrypted: !!blob,
  };
}
