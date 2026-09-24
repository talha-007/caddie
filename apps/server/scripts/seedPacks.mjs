/**
 * Seeds the real Druids packs into the dummy store, plus the one garment the
 * Ambassador Pack needs and the store did not stock.
 *
 * Why the packs are Shopify products at all: the project rule is that Shopify
 * owns product data and we own recommendations. A pack has both. The name and
 * the £99 come from Shopify, like any other price; which six garments go in it
 * is ours, and lives in `src/recommend/packs.ts`.
 *
 * Contents and prices are the real ones from druids.com:
 *   Ambassador Pack   6 items, £99 - jacket, midlayer, polo, trouser,
 *                     belt or cap, socks
 *   Rainsuit Special  £99 - rain jacket and trousers, with a beanie
 *
 * The other ten bundles Druids sells (Prestige Pack, Players Bundle, Any 3
 * Polos, the ladies and kids ranges) are deliberately not here: their prices
 * were not published on any page we could read, and a made-up price on a pack
 * is exactly the thing the Caddie must never do.
 *
 * Images are borrowed from products already in the store, as in seedStore.mjs.
 * They show the right kind of garment and this is a test store. Replace with
 * real Druids photography before a client sees it.
 */

// Credentials come from the environment - source .env before running.
const STORE = process.env.DRUIDS_STORE;
const TOKEN = process.env.DUMMY_STORE_ACCESS_TOKEN;
if (!STORE || !TOKEN) throw new Error('Set DRUIDS_STORE and DUMMY_STORE_ACCESS_TOKEN');
const CDN = 'https://cdn.shopify.com/s/files/1/0853/1794/3521/files';

const PRODUCTS = [
  /*
   * The Ambassador Pack's fifth slot is "belt or cap". The store had a beanie
   * and nothing else for it, so the slot could only ever be filled one way.
   */
  {
    title: 'TOUR BELT - BLACK',
    productType: 'BELTS',
    price: '22.00',
    colour: 'black',
    image: `${CDN}/leather-belt--black.png`,
    sizes: ['S/M', 'L/XL'],
    tags: ['belt'],
    description:
      'Full grain leather belt with a brushed gunmetal buckle and a debossed Druids mark at the keeper. Cut to sit flat under a golf trouser waistband.',
  },

  /*
   * The packs themselves. One variant each: a pack has no size of its own -
   * the sizes belong to the six garments inside it, which the Caddie asks for
   * separately.
   */
  {
    title: 'GOLF AMBASSADOR PACK',
    productType: 'PACKS',
    price: '99.00',
    colour: 'mixed',
    image: `${CDN}/IronBridgeJacket_9.jpg`,
    sizes: ['One Size'],
    tags: ['druids-pack', 'pack', 'bundle', 'ambassador'],
    description:
      'Six pieces for £99. A jacket, a midlayer, a polo, a trouser, a belt or cap and a pair of socks - enough to put a full golf outfit together for any weather. Pick each piece and its size, and we will build the pack around you.',
  },
  {
    title: 'RAINSUIT SPECIAL',
    productType: 'PACKS',
    price: '99.00',
    colour: 'mixed',
    image: `${CDN}/ScandyJacket_7.jpg`,
    sizes: ['One Size'],
    tags: ['druids-pack', 'pack', 'bundle', 'rainsuit', 'waterproof'],
    description:
      'A waterproof jacket and trousers for £99, with a beanie included. Taped seams and a full range of motion through the swing, for the days the round carries on regardless.',
  },
];

const MUTATION = `
mutation Seed($input: ProductSetInput!) {
  productSet(synchronous: true, input: $input) {
    product { id title handle status variants(first: 10) { nodes { id title price } } }
    userErrors { field message code }
  }
}`;

async function admin(query, variables) {
  const res = await fetch(`https://${STORE}/admin/api/2025-07/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

function inputFor(product) {
  return {
    title: product.title,
    vendor: 'Druids',
    productType: product.productType,
    status: 'ACTIVE',
    descriptionHtml: `<p>${product.description}</p>`,
    // druids-product is what SHOPIFY_BRAND_TAG filters on, so without it the
    // pack is invisible to every search the Caddie makes.
    tags: ['druids-product', 'mens', 'golf-clothing', product.colour, ...product.tags],
    productOptions: [{ name: 'Size', values: product.sizes.map((size) => ({ name: size })) }],
    files: [{ originalSource: product.image, contentType: 'IMAGE', alt: product.title }],
    variants: product.sizes.map((size) => ({
      optionValues: [{ optionName: 'Size', name: size }],
      price: product.price,
      // Untracked, so a demo never dies on an inventory count.
      inventoryItem: { tracked: false },
      inventoryPolicy: 'CONTINUE',
    })),
  };
}

/**
 * productSet leaves the product unpublished. This puts it on the Online Store,
 * which is what a shopper browsing the site sees - and is not enough on its
 * own. See publishToHeadless below for the half that makes it buyable.
 */
async function publish(productGid) {
  const id = productGid.split('/').pop();
  const res = await fetch(`https://${STORE}/admin/api/2025-07/products/${id}.json`, {
    method: 'PUT',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ product: { id: Number(id), published: true, published_scope: 'web' } }),
  });
  if (!res.ok) throw new Error(`publish failed ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return Boolean(body.product?.published_at);
}

/**
 * Publishing to the Online Store is not enough.
 *
 * The Storefront API - which is what the basket runs on - reads its own
 * publication, so a product published only to `web` is searchable and cannot
 * be bought: "The merchandise with id ... does not exist". Every product this
 * script seeded had that shape until it was noticed, which meant the packs
 * could be shown to a customer and not added.
 */
async function publishToHeadless(gid) {
  const pubs = await admin(`{ publications(first: 20) { nodes { id name } } }`, {});
  const headless = pubs.publications.nodes.filter((node) => /headless/i.test(node.name));
  if (headless.length === 0) return 'no headless publication on this store';

  const result = await admin(
    `mutation Publish($id: ID!, $input: [PublicationInput!]!) {
       publishablePublish(id: $id, input: $input) { userErrors { message } } }`,
    { id: gid, input: headless.map((node) => ({ publicationId: node.id })) },
  );
  const errors = result.publishablePublish?.userErrors ?? [];
  return errors.length ? errors.map((e) => e.message).join('; ') : null;
}

const only = process.argv[2];
const queue = only ? PRODUCTS.filter((p) => p.title === only) : PRODUCTS;

for (const product of queue) {
  const data = await admin(MUTATION, { input: inputFor(product) });
  const { product: created, userErrors } = data.productSet;
  if (userErrors?.length) {
    console.log('FAILED', product.title, JSON.stringify(userErrors));
    continue;
  }
  const published = await publish(created.id);
  const headlessError = await publishToHeadless(created.id);
  console.log(
    `created  ${created.title.padEnd(24)} ${created.variants.nodes.length} variant(s) @ ${created.variants.nodes[0]?.price}  ` +
      `published:${published ? 'yes' : 'NO'}  storefront:${headlessError ? 'FAILED - ' + headlessError : 'yes'}`,
  );
}
