import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

function bearerToken(req: NextRequest) {
  const authorization = req.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function secretsMatch(left: string, right: string) {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Cron endpoints accept CRON_SECRET via Authorization: Bearer <secret>
 * or ?token=<secret>. Keep this value in a private environment file.
 */
export async function hasCronAuthorization(req: NextRequest) {
  const configuredSecret = process.env.CRON_SECRET || "";
  const token = bearerToken(req);
  const querySecret = new URL(req.url).searchParams.get("token") || "";
  if (!configuredSecret) return false;
  return secretsMatch(token, configuredSecret) || secretsMatch(querySecret, configuredSecret);
}
