import type {PortfolioState,Wallet} from './types';
import {isWalletRefreshEnabled} from './wallets';

/** Requeue unstarted work; reserving a slot is not a successful wallet read. */
export function dueWeb3Wallets(wallets:Wallet[],audit:NonNullable<PortfolioState['web3Audit']>,now:number,batch=5):Wallet[]{
  return wallets.filter(wallet=>isWalletRefreshEnabled(wallet)).filter(wallet=>{
    const entry=audit.wallets[wallet.id];
    const attempted=Date.parse(entry?.lastAttemptAt??'')||0;
    const retry=Date.parse(entry?.retryAt??'')||0;
    return retry>0?now>=retry:now-attempted>=2*60000;
  }).sort((a,b)=>(Date.parse(audit.wallets[a.id]?.tokensAt??audit.wallets[a.id]?.lastAttemptAt??'')||0)-
    (Date.parse(audit.wallets[b.id]?.tokensAt??audit.wallets[b.id]?.lastAttemptAt??'')||0)).slice(0,batch);
}
