import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const COOKIE = "am_session";

function getSecret() {
  const s = process.env.SESSION_SECRET || process.env.DASHBOARD_PASSWORD;
  if (!s || s.length < 8) return null;
  return new TextEncoder().encode(s);
}

/**
 * Edge 门禁：未登录直接去 /login，减少进 layout 才鉴权的往返。
 * API 仍各自 requireAuth；不削弱登录安全。
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!pathname.startsWith("/dashboard")) {
    return NextResponse.next();
  }
  const token = req.cookies.get(COOKIE)?.value;
  const secret = getSecret();
  if (!token || !secret) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  try {
    const { payload } = await jwtVerify(token, secret);
    if (payload?.role !== "dashboard") throw new Error("role");
    return NextResponse.next();
  } catch {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
}

export const config = {
  matcher: ["/dashboard", "/dashboard/:path*"],
};
