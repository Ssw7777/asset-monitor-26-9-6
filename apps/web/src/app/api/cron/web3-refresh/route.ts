import {NextRequest,NextResponse} from 'next/server';
import {hasCronAuthorization} from '@/lib/cron-auth';
import {refreshWeb3Observations,web3Status} from '@/lib/web3-refresh';
export const preferredRegion=['hkg1'];
export const dynamic='force-dynamic';
export const maxDuration=60;
export async function GET(req:NextRequest){
  if(!await hasCronAuthorization(req))return NextResponse.json({error:'unauthorized'},{status:401});
  return NextResponse.json(await web3Status());
}
export async function POST(req:NextRequest){
  if(!await hasCronAuthorization(req))return NextResponse.json({error:'unauthorized'},{status:401});
  try{return NextResponse.json(await refreshWeb3Observations());}
  catch{return NextResponse.json({ok:false,error:'web3_refresh_failed'},{status:503});}
}
