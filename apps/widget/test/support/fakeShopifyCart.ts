/**
 * A Shopify Ajax cart with contents of its own, served by a fake fetch: the
 * fixture every widget cart test asserts against, before and after. It
 * behaves as the documented endpoints do - /cart.js reads, /cart/add.js
 * adds (422 for a sold-out variant), /cart/change.js and /cart/update.js
 * change by line key (404 for a key that no longer exists) - and, like the
 * real cart, re-keys its lines whenever an add lands. Failures and hangs are
 * injected per endpoint, so a test controls exactly what the store does
 * without touching any real inventory.
 */

export interface FakeItem {
  key: string;
  product_id: number;
  variant_id: number;
  product_title: string;
  variant_title: string | null;
  image: string | null;
  quantity: number;
  final_price: number;
  final_line_price: number;
  properties: Record<string, unknown> | null;
}

export interface Variant {
  variantId: number;
  productId: number;
  title: string;
  variantTitle: string;
  price: number;
  available?: boolean;
}

type Endpoint = 'read' | 'add' | 'change' | 'update';

export class FakeShopifyCart {
  items: FakeItem[] = [];
  private keySeq = 1;
  readonly calls: Array<{ endpoint: Endpoint; body?: unknown }> = [];
  private failures = new Map<Endpoint, { status: number; description: string; times: number }>();
  private hangs = new Set<Endpoint>();
  /** Requests that never resolve, so a test can assert what happened while they hung. */
  readonly hung: Array<{ endpoint: Endpoint }> = [];
  constructor(readonly variants: Variant[], readonly root = '/') {}

  private variant(id: number): Variant | undefined {
    return this.variants.find((entry) => entry.variantId === id);
  }

  /** Every line re-keyed, as Shopify does after an add. */
  private rekey(): void {
    for (const item of this.items) item.key = `${item.variant_id}:${this.keySeq++}`;
  }

  seed(lines: Array<{ variantId: number; quantity: number; properties?: Record<string, unknown> }>): void {
    for (const line of lines) {
      const variant = this.variant(line.variantId)!;
      this.items.push({
        key: `${line.variantId}:${this.keySeq++}`,
        product_id: variant.productId,
        variant_id: variant.variantId,
        product_title: variant.title,
        variant_title: variant.variantTitle,
        image: null,
        quantity: line.quantity,
        final_price: variant.price,
        final_line_price: variant.price * line.quantity,
        properties: line.properties ?? null,
      });
    }
  }

  failNext(endpoint: Endpoint, status: number, description: string, times = 1): void {
    this.failures.set(endpoint, { status, description, times });
  }

  hang(endpoint: Endpoint): void {
    this.hangs.add(endpoint);
  }

  unhang(endpoint: Endpoint): void {
    this.hangs.delete(endpoint);
  }

  quantities(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const item of this.items) out[item.variant_id] = (out[item.variant_id] ?? 0) + item.quantity;
    return out;
  }

  keyOf(variantId: number): string | undefined {
    return this.items.find((item) => item.variant_id === variantId)?.key;
  }

  private snapshot() {
    return { token: 'fake-cart', item_count: this.items.reduce((sum, item) => sum + item.quantity, 0), total_price: this.items.reduce((sum, item) => sum + item.final_line_price, 0), currency: 'GBP', items: this.items.map((item) => ({ ...item })) };
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  /** The fetch a test installs: the store's cart endpoints, and nothing else. */
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const endpoint: Endpoint | null = path.endsWith('/cart.js') ? 'read' : path.endsWith('/cart/add.js') ? 'add' : path.endsWith('/cart/change.js') ? 'change' : path.endsWith('/cart/update.js') ? 'update' : null;
    if (!endpoint) return this.json(404, { description: `no such endpoint ${path}` });
    if (!path.startsWith(this.root.replace(/\/$/, '') + '/')) return this.json(404, { description: `wrong root for ${path}` });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ endpoint, body });
    if (this.hangs.has(endpoint)) {
      this.hung.push({ endpoint });
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
      });
    }
    const failure = this.failures.get(endpoint);
    if (failure && failure.times > 0) {
      failure.times -= 1;
      return this.json(failure.status, { status: failure.status, description: failure.description });
    }
    if (endpoint === 'read') return this.json(200, this.snapshot());
    if (endpoint === 'add') {
      const lines = (body?.items ?? []) as Array<{ id: number; quantity: number; properties?: Record<string, unknown> }>;
      for (const line of lines) {
        const variant = this.variant(Number(line.id));
        if (!variant) return this.json(422, { status: 422, description: `Cannot find variant ${line.id}` });
        if (variant.available === false) return this.json(422, { status: 422, description: `The product '${variant.title}' is already sold out.` });
      }
      for (const line of lines) {
        const variant = this.variant(Number(line.id))!;
        const existing = this.items.find((item) => item.variant_id === variant.variantId && JSON.stringify(item.properties ?? {}) === JSON.stringify(line.properties ?? {}));
        if (existing) {
          existing.quantity += line.quantity;
          existing.final_line_price = existing.final_price * existing.quantity;
        } else {
          this.items.unshift({ key: '', product_id: variant.productId, variant_id: variant.variantId, product_title: variant.title, variant_title: variant.variantTitle, image: null, quantity: line.quantity, final_price: variant.price, final_line_price: variant.price * line.quantity, properties: line.properties ?? null });
        }
      }
      this.rekey();
      return this.json(200, { items: this.items.slice(0, lines.length) });
    }
    if (endpoint === 'change') {
      const item = this.items.find((entry) => entry.key === body.id);
      if (!item) return this.json(404, { status: 404, description: 'Cart line not found', message: 'Cart Error' });
      item.quantity = Number(body.quantity);
      item.final_line_price = item.final_price * item.quantity;
      // Properties sent replace the line's own, and the line takes a new key - as Shopify keys a line by its properties.
      if (body.properties) {
        item.properties = body.properties as Record<string, unknown>;
        item.key = `${item.variant_id}:${this.keySeq++}`;
      }
      this.items = this.items.filter((entry) => entry.quantity > 0);
      return this.json(200, this.snapshot());
    }
    // update
    for (const [key, quantity] of Object.entries((body?.updates ?? {}) as Record<string, number>)) {
      const item = this.items.find((entry) => entry.key === key);
      if (!item) return this.json(404, { status: 404, description: 'Cart line not found' });
      item.quantity = Number(quantity);
      item.final_line_price = item.final_price * item.quantity;
    }
    this.items = this.items.filter((entry) => entry.quantity > 0);
    return this.json(200, this.snapshot());
  };
}

/** The storefront the widget believes it is on. */
export function installStorefront(cart: FakeShopifyCart, root = '/'): void {
  (window as unknown as { Shopify: unknown }).Shopify = { shop: 'lachicos.myshopify.com', country: 'GB', currency: { active: 'GBP' }, routes: { root } };
  globalThis.fetch = cart.fetch as typeof fetch;
}
