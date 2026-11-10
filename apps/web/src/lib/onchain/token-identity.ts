// Verified against Zerion /v1/fungibles/eth: these chain implementations have
// an empty contract address (native ETH), not an ERC20 with the same ticker.
const ETH_CHAINS=new Set(['eth','arb','base','op','linea','abs','hood','ink','katana','megaeth','scrl','zora','era','blast','bob','mode','taiko','uni','world']);
export function canonicalTokenId(token:{chain:string;tokenId:string;symbol?:string;contractAddress?:string}):string{
  const raw=token.contractAddress?.trim()||token.tokenId.trim();
  const id=/^0x[a-f0-9]{40}$/i.test(raw)?raw.toLowerCase():raw;
  if(!token.contractAddress && id==='zerion:eth' && token.symbol==='ETH' && ETH_CHAINS.has(token.chain))return token.chain;
  return id;
}
