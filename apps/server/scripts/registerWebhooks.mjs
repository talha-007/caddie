/**
 * Points Shopify's webhooks at this server.
 *
 *   npm run webhooks --workspace=@caddie/server
 *
 * Webhooks are what keep the catalogue mirror current: Shopify tells us the
 * moment a product or a stock level moves, instead of us polling a busy store
 * on a timer that is always either stale or wasteful.
 *
 * Re-run it whenever CADDIE_PUBLIC_URL changes - a dev tunnel gets a new
 * address each time it is recreated, and a webhook pointing at a dead one
 * fails silently. Existing subscriptions for the same topic are replaced.
 */

const STORE = process.env.DRUIDS_STORE ?? process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.DUMMY_STORE_ACCESS_TOKEN ?? process.env.SHOPIFY_ADMIN_TOKEN;
const PUBLIC_URL = process.env.CADDIE_PUBLIC_URL;

if (!STORE || !TOKEN) throw new Error('Set SHOPIFY_STORE_DOMAIN and an admin token');
if (!PUBLIC_URL) throw new Error('Set CADDIE_PUBLIC_URL - Shopify has to be able to reach this server');

const CALLBACK = `${PUBLIC_URL.replace(/\/$/, '')}/api/shopify/webhook`;

/** Everything that can change what we show a customer. */
const TOPICS = ['PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'PRODUCTS_DELETE', 'INVENTORY_LEVELS_UPDATE'];

async function admin(query, variables = {}) {
  const res = await fetch(`https://${STORE}/admin/api/2025-07/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

async function existing() {
  const data = await admin(`{
    webhookSubscriptions(first: 100) {
      nodes { id topic endpoint { ... on WebhookHttpEndpoint { callbackUrl } } }
    }
  }`);
  return data.webhookSubscriptions.nodes;
}

const current = await existing();

for (const topic of TOPICS) {
  const already = current.filter((hook) => hook.topic === topic);

  // Same topic, right URL: leave it be.
  if (already.some((hook) => hook.endpoint?.callbackUrl === CALLBACK)) {
    console.log(`${topic.padEnd(24)} already pointing here`);
    continue;
  }

  // Same topic, stale URL: remove it, or Shopify keeps posting into the void.
  for (const stale of already) {
    await admin(
      `mutation($id: ID!) { webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { message } } }`,
      { id: stale.id },
    );
    console.log(`${topic.padEnd(24)} removed stale ${stale.endpoint?.callbackUrl ?? '(unknown)'}`);
  }

  const created = await admin(
    `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
       webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
         webhookSubscription { id }
         userErrors { field message }
       }
     }`,
    { topic, sub: { callbackUrl: CALLBACK, format: 'JSON' } },
  );

  const errors = created.webhookSubscriptionCreate.userErrors;
  if (errors?.length) {
    console.log(`${topic.padEnd(24)} FAILED ${JSON.stringify(errors)}`);
    continue;
  }
  console.log(`${topic.padEnd(24)} -> ${CALLBACK}`);
}

console.log('\nWebhooks are signed with the app secret; the server reads it from');
console.log('SHOPIFY_WEBHOOK_SECRET (or DUMMY_STORE_SECRET) and rejects anything else.');
