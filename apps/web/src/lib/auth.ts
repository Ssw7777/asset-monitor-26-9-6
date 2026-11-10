import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const COOKIE = "am_session";
const MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function getSecret() {
  const s = process.env.SESSION_SECRET || process.env.DASHBOARD_PASSWORD;
  if (!s || s.length < 8) {
    throw new Error("SESSION_SECRET or DASHBOARD_PASSWORD must be set");
  }
  return new TextEncoder().encode(s);
}

export function getDashboardPassword() {
  return process.env.DASHBOARD_PASSWORD || "";
}

export async function createSessionToken() {
  const secret = getSecret();
  return new SignJWT({ role: "dashboard" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret);
}

export async function verifySessionToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload?.role === "dashboard";
  } catch {
    return false;
  }
}

export async function isAuthenticated() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return false;
  return verifySessionToken(token);
}

function cookieSecure() {
  // Allow plain HTTP on VPS IP until TLS is configured.
  if (process.env.FORCE_INSECURE_COOKIES === "1") return false;
  return process.env.NODE_ENV === "production";
}

export function setSessionCookie(res: NextResponse, token: string) {
  res.cookies.set(COOKIE, token, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(COOKIE, "", {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function requireAuth() {
  const ok = await isAuthenticated();
  if (!ok) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  return null;
}
