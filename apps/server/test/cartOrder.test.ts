import { describe, expect, it } from 'vitest';
import { writesToCart } from '../src/ai/openai.js';
import { tools } from '../src/tools/index.js';

/**
 * Asked to add four garments, the model issues four add_to_cart calls in one
 * batch. They used to run together, so all four read `session.cartId` before
 * any had finished, all four found it empty, and all four opened a *separate*
 * basket. The session kept whichever wrote last.
 *
 * The customer was told "all four items have been added, totalling £100" and
 * found one item at £58. They asked why, twice, and the Caddie could not tell
 * them - it had no idea the other three carts existed.
 *
 * Cart writes now run one at a time, each re-reading the session so the second
 * add finds the basket the first opened. These pin the classification, because
 * the failure is invisible until someone adds more than one thing.
 */
describe('which tools may not run alongside each other', () => {
  it('serialises everything that writes to the basket', () => {
    expect(writesToCart('add_to_cart')).toBe(true);
    expect(writesToCart('update_cart_item')).toBe(true);
  });

  it('leaves reads free to run together', () => {
    expect(writesToCart('search_products')).toBe(false);
    expect(writesToCart('get_product_details')).toBe(false);
    expect(writesToCart('find_my_size')).toBe(false);
    expect(writesToCart('view_cart')).toBe(false);
  });

  /*
   * The check that actually catches a regression: a new cart-writing tool
   * added to the registry and not named above.
   */
  it('names every cart-writing tool in the registry', () => {
    const writers = tools
      .map((tool) => tool.name)
      .filter((name) => /cart|basket/.test(name) && name !== 'view_cart');

    for (const name of writers) {
      expect(writesToCart(name), `${name} writes to the cart but is not serialised`).toBe(true);
    }
    // If this is ever zero the filter has stopped matching and the test is dead.
    expect(writers.length).toBeGreaterThan(0);
  });
});
