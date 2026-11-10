import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { computeTotals, publicState, readStore, setUsdCnyRate } from "@/lib/store";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  const s = await readStore();
  return NextResponse.json({ usdCnyRate: s.usdCnyRate });
}

export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  const body = await req.json();
  const rate = Number(body.usdCnyRate ?? body.rate);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
    return NextResponse.json({ error: "汇率无效" }, { status: 400 });
  }
  const s = await setUsdCnyRate(rate);
  return NextResponse.json({
    ...publicState(s),
    usdCnyRate: s.usdCnyRate,
    totals: computeTotals(s),
  });
}
