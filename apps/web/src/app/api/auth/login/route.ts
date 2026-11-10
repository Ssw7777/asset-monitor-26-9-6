import { NextRequest, NextResponse } from "next/server";
import { createSessionToken, getDashboardPassword, setSessionCookie } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const password = String(body?.password || "");
    const expected = getDashboardPassword();
    if (!expected) {
      return NextResponse.json({ error: "服务器未配置 DASHBOARD_PASSWORD" }, { status: 500 });
    }
    if (password !== expected) {
      return NextResponse.json({ error: "密码错误" }, { status: 401 });
    }
    const token = await createSessionToken();
    const res = NextResponse.json({ ok: true });
    setSessionCookie(res, token);
    return res;
  } catch {
    return NextResponse.json({ error: "请求无效" }, { status: 400 });
  }
}
