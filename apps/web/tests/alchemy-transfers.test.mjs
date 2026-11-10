import {test} from 'node:test';
import assert from 'node:assert/strict';
import {alchemyQuantity} from '../src/lib/onchain/alchemy-transfers.ts';

test('uses raw amount with hex decimals instead of assuming 18',()=>{
  const usdc = alchemyQuantity({
    value: null,
    rawContract: { value: '0x3b9aca00', address: '0x'+'ab'.repeat(20), decimal: '0x6' },
  });
  assert.equal(usdc, '1000');
});

test('does not scale an ERC-20 by 18 when decimals are missing',()=>{
  assert.equal(alchemyQuantity({
    value: null,
    rawContract: { value: '0x3b9aca00', address: '0x'+'ab'.repeat(20), decimal: null },
  }), null);
});

test('trusts raw quantity when the human value disagrees by orders of magnitude',()=>{
  const fixed = alchemyQuantity({
    value: 0.000001,
    rawContract: { value: '0x3b9aca00', address: '0x'+'ab'.repeat(20), decimal: '6' },
  });
  assert.equal(fixed, '1000');
});

test('native transfers still default to 18 decimals',()=>{
  assert.equal(alchemyQuantity({
    value: null,
    rawContract: { value: '0xde0b6b3a7640000', address: null, decimal: null },
  }), '1');
});
