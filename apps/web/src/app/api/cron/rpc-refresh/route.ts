import {NextRequest,NextResponse} from 'next/server';
import {hasCronAuthorization} from '@/lib/cron-auth';
import {refreshRpcQuantities,rpcPlan} from '@/lib/rpc-refresh';
import {readLiveStore as readStore} from '@/lib/store';

export const preferredRegion=['hkg1'];
export const dynamic='force-dynamic';
export const maxDuration=60;
export async function GET(req:NextRequest){
  if(!await hasCronAuthorization(req))return NextResponse.json({error:'unauthorized'},{status:401});
  const state=await readStore();
  return NextResponse.json({ok:true,plan:[...rpcPlan(state)].map(([chain,targets])=>({chain,quantities:targets.length})),
    chains:state.rpcAudit?.chains??{},usage:state.rpcAudit?.usage??null,protocolAudit:state.rpcAudit?.protocols??{},
    protocols:state.wallets.map(wallet=>({id:wallet.id,at:state.protocolCache?.[wallet.address.toLowerCase()]?.at,
      protocols:(state.protocolCache?.[wallet.address.toLowerCase()]?.protocols??[]).map(p=>({id:p.id,name:p.name,chain:p.chain}))}))});
}
export async function POST(req:NextRequest){
  if(!await hasCronAuthorization(req))return NextResponse.json({error:'unauthorized'},{status:401});
  try{return NextResponse.json(await refreshRpcQuantities());}
  catch{return NextResponse.json({ok:false,error:'rpc_refresh_failed'},{status:503});}
}
