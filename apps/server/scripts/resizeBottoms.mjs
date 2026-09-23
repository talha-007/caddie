/**
 * Puts the seeded bottoms on Druids' real waist sizing.
 *
 * Druids sizes shorts and trousers by waist (30-42), not S/M/L - see
 * data/size-chart.json. The first seed used letter sizes, so find_my_size
 * would answer "34" for a product that only offered "M".
 *
 * Source .env before running:
 *   node scripts/resizeBottoms.mjs
 */

const STORE = process.env.DRUIDS_STORE;
const TOKEN = process.env.DUMMY_STORE_ACCESS_TOKEN;
if (!STORE || !TOKEN) throw new Error('Set DRUIDS_STORE and DUMMY_STORE_ACCESS_TOKEN');

const WAIST_SIZES = ['30', '32', '34', '36', '38', '40'];

/** Kept deliberately unbuyable so the out-of-stock path has something real. */
const OUT_OF_STOCK = new Set(['TOUR SHORT - NAVY|40']);

const PRODUCTS = [
  { id: 'gid://shopify/Product/9737782395105', title: 'TOUR SHORT - NAVY', price: '42.00' },
  { id: 'gid://shopify/Product/9737783869665', title: 'TOUR SHORT - KHAKI', price: '42.00' },
  { id: 'gid://shopify/Product/9737783902433', title: 'TECH TROUSER - BLACK', price: '58.00' },
];

const MUTATION = `
mutation Resize($input: ProductSetInput!) {
  productSet(synchronous: true, input: $input) {
    product { id title options { name values } variants(first: 20) { nodes { title price } } }
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

for (const product of PRODUCTS) {
  const input = {
    id: product.id,
    productOptions: [{ name: 'Size', values: WAIST_SIZES.map((size) => ({ name: size })) }],
    variants: WAIST_SIZES.map((size) => {
      const unavailable = OUT_OF_STOCK.has(`${product.title}|${size}`);
      return {
        optionValues: [{ optionName: 'Size', name: size }],
        price: product.price,
        inventoryItem: { tracked: unavailable },
        inventoryPolicy: unavailable ? 'DENY' : 'CONTINUE',
      };
    }),
  };

  const { productSet } = await admin(MUTATION, { input });
  if (productSet.userErrors?.length) {
    console.log('FAILED', product.title, JSON.stringify(productSet.userErrors));
    continue;
  }
  console.log(
    `${productSet.product.title.padEnd(22)} sizes: ${productSet.product.options[0].values.join(', ')}`,
  );
}
