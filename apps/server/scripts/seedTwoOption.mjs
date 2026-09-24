/**
 * Seeds one product shaped like the real Druids catalogue: two options, and a
 * price that changes with size.
 *
 * Every product in the test store has a single Size option, with the colour
 * baked into the title, and one price across every variant. That is not what
 * the live store looks like, and it hid two real faults for weeks:
 *
 *  - `add_to_cart` only asked for a choice when the customer had named
 *    nothing at all, so naming a size and not a colour let it take
 *    `variants[0]` and pick the colour itself.
 *  - Packs and outfits added up `product.price`, which is Shopify's
 *    *cheapest* variant, and presented the result as a total. A customer
 *    buying at 2XL was quoted a figure they could not check out at.
 *
 * Neither is reproducible against a single-option, single-price catalogue.
 * This product exists so both are, and so they stay fixed.
 *
 * Run: node scripts/seedTwoOption.mjs   (source .env first)
 */

const STORE = process.env.DRUIDS_STORE;
const TOKEN = process.env.DUMMY_STORE_ACCESS_TOKEN;
if (!STORE || !TOKEN) throw new Error('Set DRUIDS_STORE and DUMMY_STORE_ACCESS_TOKEN');
const CDN = 'https://cdn.shopify.com/s/files/1/0853/1794/3521/files';

const SIZES = ['S', 'M', 'L', 'XL', '2XL'];
const COLOURS = ['NAVY', 'SAGE'];

/** The bigger sizes cost more, which is what makes a minimum price a lie. */
const priceFor = (size) => (size === 'XL' ? '48.00' : size === '2XL' ? '52.00' : '42.00');

const PRODUCT = {
  title: 'TOUR POLO',
  productType: 'POLOS',
  image: `${CDN}/ScandyJacket_7.jpg`,
  description:
    'Two-colour tour polo in a breathable pique. Cut for a full shoulder turn, with a self-fabric collar and a metallic Druids mark at the chest. Sized S to 2XL in navy and sage.',
};

const MUTATION = `
mutation Seed($input: ProductSetInput!) {
  productSet(synchronous: true, input: $input) {
    product { id title handle variants(first: 20) { nodes { id title price } } }
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

function input() {
  const variants = [];
  for (const colour of COLOURS) {
    for (const size of SIZES) {
      variants.push({
        optionValues: [
          { optionName: 'Size', name: size },
          { optionName: 'Colour', name: colour },
        ],
        price: priceFor(size),
        // Untracked, so a demo never dies on an inventory count.
        inventoryItem: { tracked: false },
        inventoryPolicy: 'CONTINUE',
      });
    }
  }

  return {
    title: PRODUCT.title,
    vendor: 'Druids',
    productType: PRODUCT.productType,
    status: 'ACTIVE',
    descriptionHtml: `<p>${PRODUCT.description}</p>`,
    // Without druids-product the brand filter hides it from every search.
    tags: ['druids-product', 'mens', 'golf-clothing', 'polo', 'two-option-fixture'],
    productOptions: [
      { name: 'Size', values: SIZES.map((name) => ({ name })) },
      { name: 'Colour', values: COLOURS.map((name) => ({ name })) },
    ],
    files: [{ originalSource: PRODUCT.image, contentType: 'IMAGE', alt: PRODUCT.title }],
    variants,
  };
}

/**
 * productSet leaves the product unpublished. This puts it on the Online Store,
 * which is what a shopper browsing the site sees - and is not enough on its
 * own. See publishToHeadless below for the half that makes it buyable.
 */
async function publish(gid) {
  const id = gid.split('/').pop();
  const res = await fetch(`https://${STORE}/admin/api/2025-07/products/${id}.json`, {
    method: 'PUT',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ product: { id: Number(id), published: true, published_scope: 'web' } }),
  });
  if (!res.ok) throw new Error(`publish failed ${res.status}: ${await res.text()}`);
  return Boolean((await res.json()).product?.published_at);
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

const data = await admin(MUTATION, { input: input() });
const { product, userErrors } = data.productSet;
if (userErrors?.length) {
  console.log('FAILED', JSON.stringify(userErrors));
} else {
  const published = await publish(product.id);
  const headlessError = await publishToHeadless(product.id);
  const prices = [...new Set(product.variants.nodes.map((v) => v.price))].join(', ');
  console.log(
    `created  ${product.title}  ${product.variants.nodes.length} variants  prices ${prices}  ` +
      `published:${published ? 'yes' : 'NO'}  storefront:${headlessError ? 'FAILED - ' + headlessError : 'yes'}`,
  );
}
