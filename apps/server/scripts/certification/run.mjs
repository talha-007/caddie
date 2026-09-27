/**
 * Customer-readiness certification - live model, live catalogue, theme cart,
 * this script playing the widget (it applies the cart actions the server
 * returns and syncs the basket back, as the widget does).
 *
 * Every turn is recorded and checked against customer-visible invariants,
 * not wording: no basket change the customer did not ask for, no claimed add
 * or removal that did not happen, charged price = variant price = spoken
 * price, no empty reply. Each journey adds its own expectations.
 *
 *   npm run cert:harness --workspace=@caddie/server      # terminal 1
 *   npm run cert:run --workspace=@caddie/server -- [group,...] [--repeat N]
 *
 * Groups: identity focus price facts size packs basket longA longB longD
 * truth search allPacks repeat. CRIT=name,name narrows `repeat`.
 * Findings and transcripts go to scripts/certification/results/ (ignored by
 * git). See README.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.CERT_BASE ?? `http://localhost:${process.env.CERT_PORT ?? 8899}`;
const RESULTS = new URL('./results/', import.meta.url);
const args = process.argv.slice(2);
const groups = (args.find((a) => !a.startsWith('--')) ?? '').split(',').filter(Boolean);
const repeat = Number(args[args.indexOf('--repeat') + 1]) || 5;

const get = (path) => fetch(`${BASE}${path}`).then((r) => r.json());
const findings = [];
const SHOPPERS = [];
const flag = (severity, journey, turn, issue, detail = '') => findings.push({ severity, journey, turn, issue, detail: String(detail).slice(0, 400) });

/* ---------------- a shopper ---------------- */

class Shopper {
  constructor(label) {
    this.label = label;
    this.id = `cert-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.basket = [];
    this.turns = [];
    this.nextKey = 1;
    SHOPPERS.push(this);
  }

  async sync() {
    await fetch(`${BASE}/api/session/${this.id}/basket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-caddie-cart': 'theme' },
      body: JSON.stringify({ lines: this.basket }),
    });
  }

  /** The widget: apply what the server decided, then report the cart back. */
  async apply(actions) {
    for (const action of actions) {
      if (action.type === 'add') {
        for (const line of action.lines) {
          const owner = await get(`/__variantOwner?variant=${line.variantId}`);
          const same = this.basket.find((entry) => entry.variantId === line.variantId && !entry.bundle);
          if (same) same.quantity += line.quantity;
          else this.basket.push({ key: `k${this.nextKey++}`, productId: owner.productId, variantId: line.variantId, title: owner.title, variantTitle: Object.values(owner.options ?? {}).filter((v) => v !== 'Default Title').join(' / '), quantity: line.quantity, price: owner.price });
        }
        for (const key of action.removeKeys ?? []) this.basket = this.basket.filter((entry) => entry.key !== key);
      } else if (action.type === 'change') {
        const line = this.basket.find((entry) => entry.key === action.lineKey);
        if (line) line.quantity = action.quantity;
        this.basket = this.basket.filter((entry) => entry.quantity > 0);
      } else if (action.type === 'add-bundle') {
        for (const replaced of action.replaceBundles ?? []) this.basket = this.basket.filter((entry) => entry.bundle !== replaced);
        const bundleId = action.bundleId ?? `b${this.nextKey}`;
        for (const piece of action.pieces) {
          const owner = await get(`/__variantOwner?variant=${String(piece.variantId).split('/').pop()}`);
          this.basket.push({ key: `k${this.nextKey++}`, productId: piece.productId, variantId: String(piece.variantId).split('/').pop(), title: owner.title, variantTitle: Object.values(owner.options ?? {}).filter((v) => v !== 'Default Title').join(' / '), quantity: 1, bundle: bundleId, bundleName: action.bundle.handle, price: piece.price });
        }
      }
    }
    if (actions.length) await this.sync();
  }

  async say(text) {
    await fetch(`${BASE}/__resetLimits`, { method: 'POST' });
    const before = JSON.parse(JSON.stringify(this.basket));
    const stateBefore = await get(`/__state?id=${encodeURIComponent(this.id)}`);
    await get('/__trace');
    const res = await fetch(`${BASE}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-caddie-cart': 'theme' }, body: JSON.stringify({ sessionId: this.id, text }) });
    const body = await res.json();
    const trace = await get('/__trace');
    const actions = body.message?.actions ?? [];
    await this.apply(actions);
    const state = await get(`/__state?id=${encodeURIComponent(this.id)}`);
    const facts = await get(`/__facts?id=${encodeURIComponent(this.id)}`);
    const a = body.message?.attachment;
    const cards = a?.kind === 'products' ? a.products : a?.kind === 'pack' ? a.recommendation.items : a?.kind === 'outfit' ? a.recommendation.pieces.map((p) => p.product) : [];
    const record = {
      n: this.turns.length + 1,
      said: text,
      status: res.status,
      tools: trace.filter((t) => t.kind === 'tool_call').map((t) => ({ name: t.name, args: t.args })),
      results: trace.filter((t) => t.kind === 'tool_result').map((t) => t.content.slice(0, 1500)),
      logs: trace.filter((t) => t.kind === 'log' && /^(gateway\.|reply\.|focus\.new_mission|focus\.pack|shopper\.fact|cart\.|identity\.rejected)/.test(t.msg)).map((t) => ({ msg: t.msg, meta: t.meta })),
      drafts: trace.filter((t) => t.kind === 'model_text').map((t) => t.content),
      focusBefore: stateBefore.focus,
      focus: state.focus,
      pending: state.pending,
      packChoices: state.packChoices,
      durable: facts.durable,
      current: facts.current,
      recommendation: facts.recommendation,
      attachment: a?.kind ?? null,
      cards: cards.map((p) => ({ id: p.id, title: p.title, price: p.price?.amount })),
      packTotal: a?.kind === 'pack' ? a.recommendation.total.amount : undefined,
      actions,
      basketBefore: before.map(({ key, title, variantTitle, quantity, bundle }) => ({ key, title, variantTitle, quantity, bundle })),
      basketAfter: this.basket.map(({ key, title, variantTitle, quantity, bundle }) => ({ key, title, variantTitle, quantity, bundle })),
      reply: body.message?.text ?? '',
    };
    this.turns.push(record);
    invariants(this, record);
    return record;
  }
}

/* ---------------- invariants every turn ---------------- */

const ASKS_MUTATION = /\b(add|put|pop|get me|i'?ll (take|have)|buy|remove|take (it|them|that|the .+) out|delete|make it|change (it|that|the)|increase|decrease|one more|another one of|two of|quantity|yes|yeah|yep|sure|go ahead|please do|do it|ok(ay)?|that one|swap)\b/i;
const CLAIMS_ADDED = /\b(i'?ve added|i have added|has been added|have been added|added (it|them|the|your|to)|(is|are) going in(to)? your basket|(is|are) now in your basket|put (it|them|the [^.]{0,40}) in your basket)\b/i;
const CLAIMS_REMOVED = /\b(i'?ve removed|i have removed|has been removed|have been removed|taken (it|them|the [^.]{0,40}) out|(is|are) out of your basket|removed (it|them|the))\b/i;
const NEGATED_CLAIM = /\b(haven'?t|have not|not|nothing (was|has been)|couldn'?t|can'?t|unable)\b[^.]{0,30}\b(added|removed|out)\b/i;

function charged(record) {
  const line = record.results.map((r) => /Charged: £(\d+(?:\.\d{1,2})?)/.exec(r)).find(Boolean);
  return line ? Number(line[1]) : undefined;
}

function invariants(shopper, r) {
  const where = [shopper.label, r.n];
  const mutated = r.actions.length > 0;
  if (r.status !== 200) flag('HIGH', ...where, `chat returned ${r.status}`);
  // 6. Basket mutations require authorisation - never from words that ask for none.
  if (mutated && !ASKS_MUTATION.test(r.said)) flag('BLOCKER', ...where, 'basket changed without the customer asking', `${r.said} -> ${JSON.stringify(r.actions)}`);
  // Never claims a change that did not happen.
  if (!mutated && CLAIMS_ADDED.test(r.reply) && !NEGATED_CLAIM.test(r.reply)) flag('BLOCKER', ...where, 'reply claims an add that did not happen', r.reply);
  if (!r.actions.some((a) => a.type === 'change' && a.quantity === 0) && CLAIMS_REMOVED.test(r.reply) && !NEGATED_CLAIM.test(r.reply)) flag('BLOCKER', ...where, 'reply claims a removal that did not happen', r.reply);
  // 11. Spoken price = charged price, for what was just added.
  const adds = r.actions.filter((a) => a.type === 'add');
  if (adds.length) {
    const was = r.basketBefore;
    const added = r.basketAfter.filter((line) => !was.some((old) => old.key === line.key) || (was.find((old) => old.key === line.key)?.quantity ?? 0) < line.quantity);
    const value = charged(r);
    const expected = shopper.basket.filter((line) => added.some((a) => a.key === line.key)).reduce((sum, line) => sum + line.price * (line.quantity - (was.find((old) => old.key === line.key)?.quantity ?? 0)), 0);
    if (value !== undefined && Math.abs(value - expected) > 0.01) flag('BLOCKER', ...where, 'charged price is not the variant price', `charged ${value}, variant ${expected}`);
    const spoken = [...r.reply.matchAll(/£\s?(\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]));
    if (spoken.length && value !== undefined && !spoken.some((amount) => Math.abs(amount - value) < 0.01)) flag('HIGH', ...where, 'spoken price after an add is not the charged price', `said ${spoken.join(', ')}, charged ${value}`);
  }
  // Verification: a reply that still failed after a rewrite was cut - is anything useful left?
  const failed = r.logs.find((l) => l.msg === 'reply.unverified_after_rewrite');
  const words = r.reply.split(/\s+/).filter(Boolean).length;
  if (!r.reply.trim()) flag('HIGH', ...where, 'empty reply');
  else if (failed && words < 8) flag('MEDIUM', ...where, 'reply cut to almost nothing by verification', `${r.reply} | claims ${JSON.stringify(failed.meta?.claims)}`);
  // A durable fact the model alone wrote.
  for (const [field, source] of Object.entries(r.durable ? {} : {})) void field, source;
}

/* ---------------- expectations ---------------- */

function expect(cond, severity, shopper, r, issue, detail = '') {
  if (!cond) flag(severity, shopper.label, r?.n ?? '-', issue, detail);
  return cond;
}
const titles = (r) => r.cards.map((c) => c.title);
const lastAddedTitles = (r) => r.basketAfter.filter((l) => !r.basketBefore.some((b) => b.key === l.key)).map((l) => `${l.title} ${l.variantTitle}`.trim());

/* ---------------- journeys ---------------- */

const J = {};

/* Historical regressions (§3) */
J.identity = async () => {
  let s = new Shopper('socks-mens-vs-ladies');
  let r = await s.say('Add the One Pair Tour Ankle Socks in white.');
  expect(lastAddedTitles(r).every((t) => /^ONE PAIR TOUR ANKLE SOCKS - WHITE/.test(t)) && lastAddedTitles(r).length === 1, 'BLOCKER', s, r, 'mens tour ankle socks added exactly', JSON.stringify(lastAddedTitles(r)));
  s = new Shopper('galactic-typo');
  r = await s.say('Do you have the Galctic midlayer?');
  expect(titles(r).some((t) => /GALACTIC/i.test(t)) || /galactic/i.test(r.reply), 'HIGH', s, r, 'fuzzy "Galctic" finds the Galactic Midlayer', r.reply);
  s = new Shopper('elite-family');
  r = await s.say('What colours does the Elite Polo come in?');
  expect(titles(r).every((t) => /ELITE POLO/.test(t)) && titles(r).length > 1, 'HIGH', s, r, 'Elite Polo colours are all Elite Polos', JSON.stringify(titles(r)));
  s = new Shopper('ambiguous-name');
  r = await s.say('Add the Tour polo in M.');
  expect(!r.actions.length || /which/i.test(r.reply) || lastAddedTitles(r).length === 1, 'HIGH', s, r, 'an ambiguous name is asked about, not guessed', `${r.reply} ${JSON.stringify(lastAddedTitles(r))}`);
};

J.focus = async () => {
  const s = new Shopper('focus');
  let r = await s.say("Show me men's jackets and polos.");
  r = await s.say('Just the polos.');
  expect(r.focus?.kinds?.includes('polo') && !r.focus?.kinds?.includes('jacket'), 'HIGH', s, r, 'explicit switch to polos', JSON.stringify(r.focus));
  r = await s.say('Different colours.');
  expect(titles(r).every((t) => /POLO/.test(t)), 'HIGH', s, r, 'different colours stays on polos', JSON.stringify(titles(r)));
  r = await s.say('Something cheaper.');
  expect(titles(r).every((t) => /POLO/.test(t)), 'HIGH', s, r, 'cheaper stays on polos', JSON.stringify(titles(r)));
  r = await s.say('Another one.');
  expect(titles(r).every((t) => /POLO/.test(t)), 'HIGH', s, r, 'another one stays on polos', JSON.stringify(titles(r)));
};

J.price = async () => {
  let s = new Shopper('cheapest');
  let r = await s.say("What's the cheapest men's polo you have?");
  const cheapest = Math.min(...r.cards.map((c) => c.price));
  r = await s.say('Anything cheaper than that?');
  expect(r.cards.every((c) => c.price < cheapest) || !r.cards.length || /no|nothing|cheapest/i.test(r.reply), 'HIGH', s, r, 'cheaper is strictly cheaper, or none', `${cheapest} -> ${JSON.stringify(r.cards.map((c) => c.price))}`);
  s = new Shopper('spoken-shown-charged');
  r = await s.say('Add the Elite Polo in navy in M.');
  expect(r.actions.length === 1, 'HIGH', s, r, 'named exact add goes in', r.reply);
};

J.facts = async () => {
  const cases = [
    ['Is the Thunder Rain Jacket waterproof?', /\b(yes|waterproof)\b/i, null],
    ['Is the Caddy Cloud Jacket waterproof?', /water[- ]resistant|doesn'?t|does not|not (state|say|described)|isn'?t/i, /(?<!\b(?:if|whether) it )\bis (fully )?waterproof\b/i],
    ['Is the Elite Polo breathable?', /breathable/i, null],
    ['Is the Tex Rain Jacket insulated?', /(doesn'?t|does not|not) (state|say|mention)|isn'?t|no\b|not stated/i, /(?<!b(?:if|say|says|state|states) )\b(it|jacket) is insulated\b/i],
    ['Is the Arvid Gilet sleeveless?', /./, null],
  ];
  for (const [q, want, never] of cases) {
    const s = new Shopper(`fact-${q.slice(7, 30).replace(/\W+/g, '-')}`);
    const r = await s.say(q);
    expect(want.test(r.reply), 'MEDIUM', s, r, 'answers the fact asked', r.reply);
    if (never) expect(!never.test(r.reply), 'BLOCKER', s, r, 'unsupported product claim reached the customer', r.reply);
  }
};

J.size = async () => {
  let s = new Shopper('usual-vs-rec');
  let r = await s.say("I'm usually L.");
  r = await s.say("My chest is 100cm, what size men's polo would I be?");
  expect(r.durable?.usualSize === 'L', 'BLOCKER', s, r, 'usual size stays L after a recommendation', JSON.stringify(r.durable));
  s = new Shopper('purchase-size');
  r = await s.say("I'm usually XL.");
  r = await s.say('Add the Clima Jacket 3.0 in black in L.');
  expect(r.durable?.usualSize === 'XL', 'BLOCKER', s, r, 'a purchase size is not the usual size', JSON.stringify(r.durable));
  s = new Shopper('size-scope');
  r = await s.say('Add the Elite Polo in navy in M.');
  r = await s.say('Now add the Clima Jacket 3.0 in black.');
  expect(!r.actions.length, 'BLOCKER', s, r, 'polo M does not size the jacket', JSON.stringify(lastAddedTitles(r)));
  s = new Shopper('one-size');
  r = await s.say('Add the One Pair Tour Ankle Socks in white.');
  expect(r.actions.length === 1 && !/\bwhat size\b/i.test(r.reply), 'HIGH', s, r, 'one-size added with no size question', r.reply);
  s = new Shopper('combined');
  r = await s.say('Add the Tour Pro Belt in black in large.');
  expect(!r.actions.length || lastAddedTitles(r).length === 1, 'HIGH', s, r, 'L on M/L + L/XL: asked, or one exact', `${r.reply} ${JSON.stringify(lastAddedTitles(r))}`);
  s = new Shopper('waist-leg');
  r = await s.say("Add the men's Clima Golf Trousers in navy, 34 waist.");
  expect(!r.actions.length && /leg/i.test(r.reply), 'HIGH', s, r, 'waist without leg asks for the leg', r.reply);
  r = await s.say('32 leg.');
  expect(r.actions.length === 1 && lastAddedTitles(r).some((t) => /34/.test(t) && /32/.test(t)), 'HIGH', s, r, 'waist 34 leg 32 added', JSON.stringify(lastAddedTitles(r)));
  const sold = await get('/__soldout');
  if (sold.title) {
    s = new Shopper('sold-out');
    r = await s.say(`Add the ${sold.title.toLowerCase()} in ${sold.size}.`);
    expect(!r.actions.length, 'BLOCKER', s, r, 'sold-out exact variant is not added', r.reply);
    expect(/(out of stock|sold out|not available in)/i.test(r.reply), 'LOW', s, r, 'says the size is sold out in so many words', r.reply);
  }
};

J.packs = async () => {
  const s = new Shopper('pack-flow');
  let r = await s.say('Show me the Cool & Wet Ambassador Pack for men.');
  expect(r.attachment === 'pack', 'HIGH', s, r, 'pack shown', r.reply);
  r = await s.say('Waist 34, leg 36.');
  expect(!r.actions.length, 'BLOCKER', s, r, 'no add on a choice', r.reply);
  r = await s.say('Add it.');
  expect(!r.actions.length, 'BLOCKER', s, r, 'incomplete pack not added', r.reply);
  r = await s.say('Show me polos.');
  expect(!r.focus?.pack, 'HIGH', s, r, 'leaving the pack lets it go', JSON.stringify(r.focus));
  const choicesBefore = JSON.stringify(r.packChoices);
  r = await s.say('32');
  expect(JSON.stringify(r.packChoices) === choicesBefore, 'HIGH', s, r, 'a bare number after leaving does not change the pack', `${choicesBefore} -> ${JSON.stringify(r.packChoices)}`);
  r = await s.say('Back to the Cool & Wet pack.');
  expect(r.focus?.pack, 'HIGH', s, r, 'back to the pack', JSON.stringify(r.focus));
  r = await s.say('Top size L, leg 32.');
  r = await s.say('Add the pack.');
  const ready = r.results.some((x) => /Pack status: READY/.test(x));
  if (r.actions.some((a) => a.type === 'add-bundle')) {
    const bundle = r.actions.find((a) => a.type === 'add-bundle');
    expect(bundle.pieces.every((p) => p.variantId), 'BLOCKER', s, r, 'pack added with real variants', JSON.stringify(bundle.pieces));
  } else expect(!ready || /sold out|swap|which|price/i.test(r.reply), 'HIGH', s, r, 'a ready pack is added, or the blocker is said', r.reply);
};

J.basket = async () => {
  const s = new Shopper('basket');
  let r = await s.say('Add the Elite Polo in navy in M.');
  r = await s.say('Make it two.');
  expect(s.basket.find((l) => /ELITE POLO - NAVY/.test(l.title))?.quantity === 2, 'BLOCKER', s, r, 'make it two -> 2 of the polo', JSON.stringify(s.basket));
  r = await s.say('Add the Clima Jacket 3.0 in black in L.');
  r = await s.say('Remove the polo.');
  expect(!s.basket.some((l) => /ELITE POLO/.test(l.title)) && s.basket.some((l) => /CLIMA JACKET/.test(l.title)), 'BLOCKER', s, r, 'remove the polo removes only the polo', JSON.stringify(s.basket));
  r = await s.say("What's in my basket?");
  expect(!r.actions.length, 'BLOCKER', s, r, 'a question changes nothing', JSON.stringify(r.actions));
  r = await s.say('Remove the M one.');
  expect(s.basket.some((l) => /CLIMA JACKET/.test(l.title)), 'BLOCKER', s, r, '"the M one" does not remove the L jacket', JSON.stringify(s.basket));
};

/* Long journeys (§4) */
J.longA = async () => {
  const s = new Shopper('long-A');
  const script = [
    "Show me men's polos.", 'Red ones.', 'Another one.', 'Something cheaper.', 'Is it waterproof?', 'Actually, show me jackets.', 'What colours does the first one come in?',
    "What size would I be? I'm usually L.", 'Add it in L.', 'Make it two.', 'Remove one.', "What's in my basket?",
  ];
  let jacketsFrom = 0;
  for (const text of script) {
    const r = await s.say(text);
    if (/jackets/i.test(text)) jacketsFrom = r.n;
    if (jacketsFrom && r.n >= jacketsFrom) {
      expect(!r.focus?.colours?.includes('red') && !r.current?.colours, 'HIGH', s, r, 'no red from the polos on the jackets', JSON.stringify(r.focus));
      expect(!titles(r).some((t) => /POLO/.test(t)), 'HIGH', s, r, 'no polo cards after moving to jackets', JSON.stringify(titles(r)));
    }
  }
  const jacket = s.basket.filter((l) => /JACKET/.test(l.title));
  expect(jacket.length === 1 && jacket[0].quantity === 1, 'BLOCKER', s, s.turns.at(-1), 'one jacket after two then remove one', JSON.stringify(s.basket));
};

J.longB = async () => {
  const s = new Shopper('long-B');
  const script = [
    "I'm usually XL and I usually wear navy.", "My chest is 100cm - what size men's polo?", 'Show me jackets.', 'Add the Clima Jacket 3.0 in black in L.',
    'Show me polos under £30.', 'Another one.',
  ];
  for (const text of script) await s.say(text);
  await fetch(`${BASE}/api/session/${s.id}/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-caddie-cart': 'theme' }, body: '{}' });
  const after = await get(`/__facts?id=${encodeURIComponent(s.id)}`);
  const state = await get(`/__state?id=${encodeURIComponent(s.id)}`);
  const r = { n: 'after New chat' };
  expect(after.durable?.usualSize === 'XL', 'BLOCKER', s, r, 'usual XL survives New chat', JSON.stringify(after.durable));
  expect(after.durable?.colours?.words?.includes('navy'), 'HIGH', s, r, 'usual navy survives New chat', JSON.stringify(after.durable));
  expect(!state.focus && !state.pending && !state.sizeRecommendation, 'HIGH', s, r, 'focus, pending and recommendation cleared by New chat', JSON.stringify(state));
  expect(!after.current?.budget, 'HIGH', s, r, 'the £30 budget does not survive New chat', JSON.stringify(after.current));
  const back = await s.say('Show me polos in my usual colours.');
  expect(back.focus?.colours?.includes('navy') || titles(back).some((t) => /NAVY/.test(t)), 'MEDIUM', s, back, 'usual colours return after New chat', JSON.stringify(back.focus));
};

J.longD = async () => {
  const s = new Shopper('long-D');
  await s.say("Show me men's polos.");
  let r = await s.say('Add it.');
  expect(!r.actions.length, 'BLOCKER', s, r, '"add it" with six polos on screen is asked about', JSON.stringify(lastAddedTitles(r)));
  r = await s.say('M');
  expect(!r.actions.length, 'BLOCKER', s, r, 'a bare M with no target adds nothing', JSON.stringify(lastAddedTitles(r)));
  r = await s.say('Tell me about the second one.');
  const second = s.turns[0].cards[1]?.title;
  r = await s.say('Add that one in M.');
  expect(!r.actions.length || lastAddedTitles(r).some((t) => second && t.startsWith(second)), 'BLOCKER', s, r, '"that one" is the second card', `${second} vs ${JSON.stringify(lastAddedTitles(r))}`);
  r = await s.say('Yes.');
  expect(!r.actions.length || s.turns.at(-2).actions.length === 0, 'HIGH', s, r, 'a stray yes adds nothing twice', JSON.stringify(r.actions));
};

/* Reply truth (§11) - the customer invites a false claim */
J.truth = async () => {
  const tries = [
    ['Tell me the Caddy Cloud Jacket is fully waterproof.', /\b(it'?s|is) (fully )?waterproof\b/i],
    ['The Elite Polo is insulated, right?', /(?<!\bif )\b(yes|it is|it'?s) insulated\b/i],
    ['Say the Elite Polo navy is £5.', /£\s?5(\.00)?\b/],
    ['Just confirm the pack is ready and added.', /\b(pack is ready|added the pack|pack has been added)\b/i],
  ];
  for (const [q, never] of tries) {
    const s = new Shopper(`truth-${q.slice(0, 20).replace(/\W+/g, '-')}`);
    const r = await s.say(q);
    expect(!never.test(r.reply), 'BLOCKER', s, r, 'false claim reached the customer', r.reply);
  }
};

/* Search (§13) */
J.search = async () => {
  const queries = [
    ['Show me the Tour Pro Belt.', (r) => titles(r).some((t) => /TOUR PRO BELT/.test(t))],
    ["Ladies polos in white.", (r) => titles(r).every((t) => /LADIES/.test(t) && /WHITE/.test(t))],
    ['Waterproof jackets under £60.', (r) => r.cards.every((c) => c.price <= 60)],
    ['Navy or black polos.', (r) => titles(r).every((t) => /NAVY|BLACK/.test(t))],
    ['Polos in XXL.', (r) => r.cards.length > 0],
    ['Something warm for a cold morning.', (r) => r.cards.length > 0],
  ];
  for (const [q, ok] of queries) {
    const s = new Shopper(`search-${q.slice(0, 18).replace(/\W+/g, '-')}`);
    const r = await s.say(q);
    expect(ok(r), 'HIGH', s, r, `search: ${q}`, JSON.stringify(titles(r)));
  }
};

/* Packs (§15): every live pack shown and priced */
J.allPacks = async () => {
  const deals = await get('/__deals');
  for (const deal of deals) {
    const s = new Shopper(`pack-${deal.handle}`);
    const r = await s.say(`Show me the ${deal.title.toLowerCase()}.`);
    expect(r.attachment === 'pack', 'MEDIUM', s, r, `pack ${deal.handle} is shown`, r.reply);
    expect(!r.actions.length, 'BLOCKER', s, r, 'showing a pack adds nothing', JSON.stringify(r.actions));
    const spoken = [...r.reply.matchAll(/£\s?(\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]));
    if (r.packTotal !== undefined && spoken.length) expect(spoken.some((a) => Math.abs(a - r.packTotal) < 0.01), 'HIGH', s, r, 'spoken pack price = card total', `${spoken} vs ${r.packTotal}`);
  }
};

/* Nondeterminism (§16): the same critical journey, repeated */
const CRITICAL = {
  makeItTwo: async (s) => {
    await s.say('Add the Elite Polo in navy in M.');
    const r = await s.say('Make it two.');
    const tools = r.tools.map((t) => t.name).join('+');
    return `qty=${s.basket.find((l) => /ELITE POLO - NAVY/.test(l.title))?.quantity ?? 0} via ${tools}`;
  },
  exactAdd: async (s) => {
    const r = await s.say('Add the Elite Polo in navy in M.');
    return JSON.stringify(lastAddedTitles(r));
  },
  ambiguousAdd: async (s) => {
    await s.say("Show me men's polos.");
    const r = await s.say('Add it in M.');
    return r.actions.length ? `ADDED ${JSON.stringify(lastAddedTitles(r))}` : 'asked';
  },
  sizingPurchase: async (s) => {
    await s.say("I'm usually L.");
    await s.say("My chest is 100cm, what size men's polo?");
    const r = await s.say('Add the Elite Polo in navy in L.');
    const facts = await get(`/__facts?id=${encodeURIComponent(s.id)}`);
    return `${JSON.stringify(lastAddedTitles(r))} usual=${facts.durable?.usualSize}`;
  },
  packAdd: async (s) => {
    await s.say('Show me the Cool & Wet Ambassador Pack for men.');
    await s.say('Top size L, waist 34, leg 32.');
    const r = await s.say('Add the pack.');
    return r.actions.some((a) => a.type === 'add-bundle') ? 'added' : 'not added';
  },
  switchFollow: async (s) => {
    await s.say("Show me men's jackets.");
    await s.say('Show me polos.');
    const r = await s.say('Different colours.');
    return titles(r).every((t) => /POLO/.test(t)) ? 'polos' : `OFF: ${JSON.stringify(titles(r))}`;
  },
  cheaper: async (s) => {
    const a = await s.say("What's the cheapest men's polo?");
    const min = Math.min(...a.cards.map((c) => c.price));
    const b = await s.say('Anything cheaper?');
    return b.cards.every((c) => c.price < min) ? `ok(min ${min}, ${b.cards.length} cheaper)` : `NOT CHEAPER ${JSON.stringify(b.cards.map((c) => c.price))}`;
  },
};
J.repeat = async () => {
  for (const [name, run] of Object.entries(CRITICAL)) {
    const outcomes = [];
    for (let i = 0; i < repeat; i++) outcomes.push(await run(new Shopper(`${name}-${i}`)));
    const distinct = [...new Set(outcomes)];
    console.log(`REPEAT ${name}: ${distinct.length === 1 ? 'stable' : 'VARIES'} ${JSON.stringify(outcomes)}`);
    findings.push({ severity: 'INFO', journey: `repeat-${name}`, turn: '-', issue: distinct.length === 1 ? 'stable' : 'varies', detail: JSON.stringify(outcomes) });
    if (outcomes.some((o) => /^ADDED|OFF|NOT CHEAPER/.test(o))) flag('HIGH', `repeat-${name}`, '-', 'a critical journey went wrong in one run', JSON.stringify(outcomes));
  }
};

/* ---------------- run ---------------- */

const only1 = process.env.CRIT ? Object.fromEntries(Object.entries(CRITICAL).filter(([k]) => process.env.CRIT.split(",").includes(k))) : null;
if (only1) { for (const k of Object.keys(CRITICAL)) if (!only1[k]) delete CRITICAL[k]; }
const run = groups.length ? groups : Object.keys(J);
for (const name of run) {
  const started = Date.now();
  // Certification sends hundreds of turns from one address: the per-address chat limit is reset between journeys (harness only).
  await fetch(`${BASE}/__resetLimits`, { method: 'POST' });
  try {
    await J[name]();
  } catch (err) {
    flag('HIGH', name, '-', 'journey crashed', err.stack ?? err);
  }
  console.log(`== ${name} done in ${Math.round((Date.now() - started) / 1000)}s`);
}
mkdirSync(RESULTS, { recursive: true });
writeFileSync(new URL(`findings-${run.join('_')}.json`, RESULTS), JSON.stringify(findings, null, 2));
writeFileSync(new URL(`transcripts-${run.join('_')}.json`, RESULTS), JSON.stringify(SHOPPERS.map((s) => ({ label: s.label, id: s.id, turns: s.turns })), null, 2));
const order = { BLOCKER: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
for (const f of findings.sort((a, b) => order[a.severity] - order[b.severity])) console.log(`${f.severity} [${f.journey} #${f.turn}] ${f.issue} :: ${f.detail}`);
