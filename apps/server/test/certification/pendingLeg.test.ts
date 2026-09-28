import { beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { readCustomerTurn } from '../../src/ai/turn.js';
import { setDealsForTests } from '../../src/catalog/bundles.js';
import { setCatalogueForTests } from '../../src/catalog/sync.js';
import { env } from '../../src/env.js';
import { sessions } from '../../src/session/store.js';
import { runTool } from '../../src/tools/index.js';
import type { ToolContext } from '../../src/tools/types.js';

/** Certification: the live waist-then-leg add - the model first passed {Size: 34} for trousers sized WAIST SIZE / LEG LENGTH. */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
const combos = ['32', '34'].flatMap((waist) => ['30', '32'].map((leg) => ({ 'WAIST SIZE': waist, 'LEG LENGTH': leg })));
const TROUSERS: Product = {
  id: 'gid://shopify/Product/97000',
  title: "MEN'S CLIMA GOLF TROUSERS - NAVY",
  url: '',
  imageUrl: null,
  vendor: 'Druids',
  productType: 'TROUSERS',
  tags: [...BRAND],
  price: { amount: 30, currency: 'GBP' },
  options: [{ name: 'WAIST SIZE', values: ['32', '34'] }, { name: 'LEG LENGTH', values: ['30', '32'] }],
  variants: combos.map((combo, i) => ({ id: `gid://shopify/ProductVariant/${97001 + i}`, title: `${combo['WAIST SIZE']} / ${combo['LEG LENGTH']}`, available: true, price: { amount: 30, currency: 'GBP' }, options: combo })),
  description: 'Stretch trousers.',
};

let id = '';
beforeEach(async () => {
  setCatalogueForTests([TROUSERS]);
  setDealsForTests([]);
  id = `cert-leg-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme', widgetContract: 'cart-ops/1' });
});
async function turn(said: string, args: Record<string, unknown>, reply = 'OK.') {
  await readCustomerTurn(id, said);
  const ctx: ToolContext = { session: await sessions.getOrCreate(id), utterance: said };
  const result = await runTool('add_to_cart', args, ctx);
  await sessions.append(id, [
    { id: `u-${Math.random()}`, role: 'user', text: said, createdAt: new Date().toISOString() },
    { id: `a-${Math.random()}`, role: 'assistant', text: result.speech || reply, createdAt: new Date().toISOString() },
  ]);
  return result;
}
const added = (result: Awaited<ReturnType<typeof runTool>>) => (result.actions ?? []).flatMap((a) => ('lines' in a ? a.lines : []));

describe('certification: waist, then leg', () => {
  it('the model passed Size: 34; "32 leg." then adds 34/32 - or asks - but never a wrong variant', async () => {
    const first = await turn("Add the men's Clima Golf Trousers in navy, 34 waist.", { productId: TROUSERS.id, options: { Size: '34' } });
    expect(added(first)).toEqual([]);
    const second = await turn('32 leg.', { productId: TROUSERS.id, options: { 'WAIST SIZE': '34', 'LEG LENGTH': '32' } });
    const lines = added(second);
    if (lines.length) expect(lines).toEqual([{ variantId: '97004', quantity: 1 }]);
    console.log('CERT leg continuation:', lines.length ? 'added 34/32' : `not added - ${second.speech}`);
  });
});
