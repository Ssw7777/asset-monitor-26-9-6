import {createHmac} from 'node:crypto';

const READ_ONLY_PATHS = new Set([
  '/api/v6/dex/balance/supported/chain', '/api/v6/dex/balance/all-token-balances-by-address',
  '/api/v6/dex/balance/total-value-by-address', '/api/v6/dex/post-transaction/transactions-by-address',
  '/api/v6/defi/product/supported-chains', '/api/v6/defi/user/asset/platform/list', '/api/v6/defi/user/asset/platform/detail',
]);
export interface OkxWeb3Credentials {key:string;secret:string;passphrase:string}
export function web3Credentials():OkxWeb3Credentials|null {
  // Production stores OnchainOS keys as OKX_ONCHAINOS_*; OKX_WEB3_* remains the canonical name.
  const key=process.env.OKX_WEB3_API_KEY||process.env.OKX_ONCHAINOS_API_KEY;
  const secret=process.env.OKX_WEB3_API_SECRET||process.env.OKX_ONCHAINOS_API_SECRET;
  const passphrase=process.env.OKX_WEB3_PASSPHRASE||process.env.OKX_ONCHAINOS_API_PASSPHRASE;
  // Never fall back to CEX trading keys or Agentic Wallet login credentials.
  return key&&secret&&passphrase?{key,secret,passphrase}:null;
}
export function web3Headers(credentials:OkxWeb3Credentials,method:'GET'|'POST',path:string,body='',timestamp=new Date().toISOString()) {
  return {'Content-Type':'application/json','OK-ACCESS-KEY':credentials.key,'OK-ACCESS-PASSPHRASE':credentials.passphrase,
    'OK-ACCESS-TIMESTAMP':timestamp,'OK-ACCESS-SIGN':createHmac('sha256',credentials.secret).update(timestamp+method+path+body).digest('base64')};
}
export async function web3Read(path:string,body?:unknown,options:{credentials?:OkxWeb3Credentials;request?:typeof fetch}={}) {
  const url=new URL(path,'https://web3.okx.com');
  if(url.origin!=='https://web3.okx.com'||url.hash||!READ_ONLY_PATHS.has(url.pathname))throw new Error('web3_non_read_endpoint');
  const method=body===undefined?'GET':'POST';
  if((method==='POST')!==['/api/v6/defi/user/asset/platform/list','/api/v6/defi/user/asset/platform/detail'].includes(url.pathname))throw new Error('web3_invalid_method');
  const credentials=options.credentials??web3Credentials();if(!credentials)throw new Error('web3_keys_missing');
  const serialized=body===undefined?'':JSON.stringify(body);
  const response=await (options.request??fetch)(url,{method,headers:web3Headers(credentials,method,url.pathname+url.search,serialized),
    ...(body===undefined?{}:{body:serialized}),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(8000)});
  // In particular, 402 is never paid/retried. No payment or execution endpoints are allowed here.
  if(!response.ok)throw new Error(`web3_http_${response.status}`);
  const data=await response.json();
  if(!data||String(data.code)!=='0')throw new Error(`web3_code_${/^\d{1,8}$/.test(String(data?.code))?data.code:'invalid'}`);
  return data as Record<string,unknown>;
}
