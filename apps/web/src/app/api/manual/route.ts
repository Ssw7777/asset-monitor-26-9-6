import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { normalizeManualAsset } from "@/lib/manual-assets";
import { computeTotals, deleteManual, publicState, readStore, upsertManual } from "@/lib/store";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  const s = await readStore();
  return NextResponse.json({ manual: s.manual, totals: computeTotals(s) });
}

export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  const body = await req.json();
  const s0 = await readStore();
  const item = normalizeManualAsset(
    {
      id: body.id,
      name: body.name,
      currency: body.currency,
      amount: body.amount,
      amountUsd: body.amountUsd,
      updatedAt: new Date().toISOString(),
    },
    Number(s0.usdCnyRate) || 6.66
  );
  const s = await upsertManual(item);
  return NextResponse.json({
    ...publicState(s),
    manual: s.manual,
    totals: computeTotals(s),
  });
}

export async function PUT(req: NextRequest) {
  return POST(req);
}

export async function DELETE(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  const s = await deleteManual(id);
  return NextResponse.json({ manual: s.manual, totals: computeTotals(s) });
}
