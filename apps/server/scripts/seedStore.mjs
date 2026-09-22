/**
 * Seeds the missing Druids pieces into the dummy store so the outfit journey
 * can actually be completed: bottoms, headwear and socks.
 *
 * Prices are plain numbers. The store is still PKR today; once the base
 * currency is switched to GBP, Shopify keeps the number and swaps the label,
 * so 42 becomes GBP 42.00 - which is why these are written as pounds.
 *
 * Images are reused from the existing demo products: they depict the right
 * garment, and this is a test store. Replace with real Druids photography
 * before anything is shown to the client.
 */

// Credentials come from the environment - source .env before running.
const STORE = process.env.DRUIDS_STORE;
const TOKEN = process.env.DUMMY_STORE_ACCESS_TOKEN;
if (!STORE || !TOKEN) throw new Error('Set DRUIDS_STORE and DUMMY_STORE_ACCESS_TOKEN');
const CDN = 'https://cdn.shopify.com/s/files/1/0853/1794/3521/files';

const TOP_SIZES = ['S', 'M', 'L', 'XL', '2XL'];

/** One variant that is genuinely unbuyable, so we can test the unhappy path. */
const OUT_OF_STOCK = new Set(['TOUR SHORT - NAVY|2XL']);

const PRODUCTS = [
  {
    title: 'TOUR SHORT - NAVY',
    productType: 'SHORTS',
    price: '42.00',
    colour: 'navy',
    image: `${CDN}/everyday-shorts--navy.png`,
    sizes: TOP_SIZES,
    description:
      'Lightweight four-way stretch golf short with a hidden comfort waistband. Water repellent finish, two side pockets and a rear zip pocket. Druids metallic logo on the left leg.',
  },
  {
    title: 'TOUR SHORT - KHAKI',
    productType: 'SHORTS',
    price: '42.00',
    colour: 'khaki',
    image: `${CDN}/everyday-shorts--khaki.png`,
    sizes: TOP_SIZES,
    description:
      'Lightweight four-way stretch golf short with a hidden comfort waistband. Water repellent finish, two side pockets and a rear zip pocket. Druids metallic logo on the left leg.',
  },
  {
    title: 'TECH TROUSER - BLACK',
    productType: 'TROUSERS',
    price: '58.00',
    colour: 'black',
    image: `${CDN}/performance-joggers--black.png`,
    sizes: TOP_SIZES,
    description:
      'Tapered performance trouser in a brushed stretch fabric. Warm, breathable and quick drying, cut for a full range of motion through the swing.',
  },
  {
    title: 'TOUR BEANIE - BLACK',
    productType: 'HEADWEAR',
    price: '22.00',
    colour: 'black',
    image: `${CDN}/ribbed-beanie--black.png`,
    sizes: ['One Size'],
    description: 'Ribbed knit beanie with a turned cuff and woven Druids badge. Warm without the bulk.',
  },
  {
    title: 'PERFORMANCE SOCKS - WHITE',
    productType: 'SOCKS',
    price: '16.00',
    colour: 'white',
    image: `${CDN}/organic-cotton-socks-3-pack--white.png`,
    sizes: ['S/M', 'L/XL'],
    description: 'Three pairs of cushioned ankle socks with arch support and a mesh vent panel.',
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
    tags: ['druids-product', 'mens', 'golf-clothing', product.colour, product.productType.toLowerCase()],
    productOptions: [{ name: 'Size', values: product.sizes.map((size) => ({ name: size })) }],
    files: [{ originalSource: product.image, contentType: 'IMAGE', alt: product.title }],
    variants: product.sizes.map((size) => {
      const unavailable = OUT_OF_STOCK.has(`${product.title}|${size}`);
      return {
        optionValues: [{ optionName: 'Size', name: size }],
        price: product.price,
        // Untracked stock keeps the demo alive; the one deliberate exception is
        // tracked with nothing on hand, so "out of stock" can be exercised.
        inventoryItem: { tracked: unavailable },
        inventoryPolicy: unavailable ? 'DENY' : 'CONTINUE',
      };
    }),
  };
}

/**
 * productSet creates the product but leaves it unpublished, and publishing
 * over GraphQL needs write_publications, which this token does not have.
 * The REST endpoint accepts it under write_products.
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
  console.log(
    `created  ${created.title.padEnd(26)} ${created.variants.nodes.length} variants @ ${created.variants.nodes[0]?.price}  published:${published ? 'yes' : 'NO'}`,
  );
}
