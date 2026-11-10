import type {WalletTokenCacheEntry} from '../types';
import {canonicalTokenId} from './token-identity.ts';

// Public market IDs only. This request never includes wallet addresses.
export const COINSTATS_PRICE_IDS=['bitcoin','ethereum','binance-coin','tether','usd-coin','global-dollar','pudgy-penguins','dai','ethena-usde','first-digital-usd','paypal-usd','frax','aave','chainlink','uniswap','wrapped-bitcoin'];
const CHAINS:Record<string,string>={ethereum:'eth','arbitrum-one':'arb',base:'base','optimistic-ethereum':'op','binance_smart':'bsc','binance-smart-chain':'bsc','polygon-pos':'matic',avalanche:'avax',abstract:'abs',robinhood:'hood','x-layer':'xlayer',ink:'ink',linea:'linea',scroll:'scrl',monad:'monad',plasma:'plasma',arc:'arc','merlin-chain':'merlin'};
const NATIVE:Record<string,{id:string;symbol:string}>={
  eth:{id:'ethereum',symbol:'ETH'},arb:{id:'ethereum',symbol:'ETH'},base:{id:'ethereum',symbol:'ETH'},op:{id:'ethereum',symbol:'ETH'},linea:{id:'ethereum',symbol:'ETH'},abs:{id:'ethereum',symbol:'ETH'},hood:{id:'ethereum',symbol:'ETH'},ink:{id:'ethereum',symbol:'ETH'},scrl:{id:'ethereum',symbol:'ETH'},zora:{id:'ethereum',symbol:'ETH'},katana:{id:'ethereum',symbol:'ETH'},megaeth:{id:'ethereum',symbol:'ETH'},
  bsc:{id:'binance-coin',symbol:'BNB'},opbnb:{id:'binance-coin',symbol:'BNB'},merlin:{id:'bitcoin',symbol:'BTC'},
};
export type MarketQuote={coinId:string;price:number;at:string};
export function parseCoinStatsPrices(raw:unknown,at:string):Record<string,MarketQuote>{
  if(!raw||typeof raw!=='object'||!Array.isArray((raw as {result?:unknown}).result))throw new Error('invalid_market_payload');
  const data=raw as {result:unknown[];meta?:{hasNextPage?:boolean}};
  if(data.meta?.hasNextPage)throw new Error('incomplete_market_page');
  const quotes:Record<string,MarketQuote>={};
  function set(identity:string,quote:MarketQuote){
    if(quotes[identity]&&quotes[identity].coinId!==quote.coinId)throw new Error('ambiguous_market_identity');
    quotes[identity]=quote;
  }
  for(const raw of data.result){
    if(!raw||typeof raw!=='object')throw new Error('invalid_market_row');
    const coin=raw as {id:string;symbol:string;price:unknown;contractAddresses?:Array<{blockchain:string;contractAddress:string}>};
    if(typeof coin.id!=='string'||typeof coin.symbol!=='string'||typeof coin.price!=='number'||!Number.isFinite(coin.price)||coin.price<=0)throw new Error('invalid_market_price');
    const quote={coinId:coin.id,price:coin.price,at};
    for(const [chain,native] of Object.entries(NATIVE))if(native.id===coin.id&&native.symbol===coin.symbol)set(`${chain}:${chain}`,quote);
    for(const contract of coin.contractAddresses??[]){
      const chain=CHAINS[contract.blockchain],address=contract.contractAddress?.toLowerCase();
      if(chain&&/^0x[a-f0-9]{40}$/.test(address))set(`${chain}:${address}`,quote);
    }
  }
  if(!Object.keys(quotes).length)throw new Error('empty_market_prices');
  return quotes;
}

/** Exact contract+chain matching. A matching ticker alone is insufficient. */
export function applyMarketPrices(previous:WalletTokenCacheEntry,quotes:Record<string,MarketQuote>):{cache:WalletTokenCacheEntry;updated:number}{
  let updated=0;
  const metadata={...previous.rpcTokenMetadata};
  const tokens=previous.tokens.map(token=>{
    const id=canonicalTokenId(token),quote=quotes[`${token.chain}:${id}`];
    const priceAt=token.priceUpdatedAt??token.updatedAt??previous.chainUpdatedAt?.[token.chain]??previous.at;
    if(!quote||Date.parse(quote.at)<=Date.parse(priceAt)||!Number.isFinite(token.amount)||token.amount<0)return token;
    updated++;
    const next={...token,valueUsd:token.amount*quote.price,valuationPrice:quote.price,priceUpdatedAt:quote.at,priceSource:'coinstats' as const};
    if(metadata[`${token.chain}:${id}`])metadata[`${token.chain}:${id}`]={...next};
    return next;
  });
  return {cache:{...previous,tokens,rpcTokenMetadata:metadata},updated};
}
