/**
 * Publishes the UCP agent profile to the store's CDN and prints its URL.
 *
 *   npm run publish:profile --workspace=@caddie/server
 *
 * Why not just serve it from our own server? Shopify insists the profile is
 * cacheable, and a VS Code dev tunnel injects `Cache-Control: no-cache,
 * no-store` on the way out, which fails discovery with "Invalid cache control".
 * The profile is static - it says nothing about where our server lives - so
 * hosting it on the Shopify CDN sidesteps the tunnel entirely. The CDN serves
 * it with a year-long max-age.
 *
 * Put the URL it prints into UCP_AGENT_PROFILE_URL. Re-run after editing
 * src/ucp/agentProfile.ts.
 *
 * In production, drop UCP_AGENT_PROFILE_URL and let CADDIE_PUBLIC_URL point at
 * /ucp/agent-profile.json on the deployed server, which sets its own headers.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STORE = process.env.DRUIDS_STORE ?? process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.DUMMY_STORE_ACCESS_TOKEN;
if (!STORE || !TOKEN) throw new Error('Set SHOPIFY_STORE_DOMAIN (or DRUIDS_STORE) and DUMMY_STORE_ACCESS_TOKEN');

const API = `https://${STORE}/admin/api/2025-07/graphql.json`;
const FILENAME = 'caddie-agent-profile.json';

async function admin(query, variables) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

/** The same file the server serves, so the two cannot disagree. */
function readProfile() {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, '../data/agent-profile.json'), 'utf8');
}

async function main() {
  const json = readProfile();

  // 1. Ask Shopify for somewhere to put it.
  const staged = await admin(
    `mutation($input:[StagedUploadInput!]!){ stagedUploadsCreate(input:$input){
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message } } }`,
    {
      input: [
        {
          filename: FILENAME,
          mimeType: 'application/json',
          resource: 'FILE',
          httpMethod: 'POST',
          fileSize: String(Buffer.byteLength(json)),
        },
      ],
    },
  );

  const target = staged.stagedUploadsCreate.stagedTargets?.[0];
  if (!target) throw new Error(JSON.stringify(staged.stagedUploadsCreate.userErrors));

  // 2. Upload the bytes.
  const form = new FormData();
  for (const param of target.parameters) form.append(param.name, param.value);
  form.append('file', new Blob([json], { type: 'application/json' }), FILENAME);

  const upload = await fetch(target.url, { method: 'POST', body: form });
  if (!upload.ok) throw new Error(`Upload failed ${upload.status}: ${await upload.text()}`);

  // 3. Register it as a file so it gets a CDN url.
  const created = await admin(
    `mutation($files:[FileCreateInput!]!){ fileCreate(files:$files){
      files { id ... on GenericFile { url } }
      userErrors { field message code } } }`,
    {
      files: [
        { originalSource: target.resourceUrl, contentType: 'FILE', alt: 'Druids Personal Caddie UCP agent profile' },
      ],
    },
  );

  const errors = created.fileCreate.userErrors;
  if (errors?.length) throw new Error(JSON.stringify(errors));
  const id = created.fileCreate.files[0].id;

  // 4. The url is null until processing finishes.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const node = await admin(`{ node(id:"${id}"){ ... on GenericFile { fileStatus url } } }`);
    if (node.node?.fileStatus === 'READY' && node.node.url) {
      console.log('\nProfile published. Put this in .env:\n');
      console.log(`UCP_AGENT_PROFILE_URL=${node.node.url}\n`);
      return;
    }
  }
  throw new Error('File never became READY - check the Files area in the Shopify admin.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
