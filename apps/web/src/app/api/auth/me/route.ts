import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";

export async function GET() {
  const ok = await isAuthenticated();
  return NextResponse.json({ authenticated: ok }, { status: ok ? 200 : 401 });
}
