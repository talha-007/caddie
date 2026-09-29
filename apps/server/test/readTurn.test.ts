import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The model-based reader of one customer message (ai/readTurn.ts): a second
 * reader that fills only what the pattern readers left empty, with values the
 * code can vouch for - and steps aside entirely when the model is down.
 */
let modelJson: Record<string, unknown> | null = { affirms: false, declines: false, asksToAdd: false, asksToRemove: false, size: null, waist: null, leg: null, colours: [], quantity: null, language: 'en' };
let calls = 0;
let fail = false;

vi.mock('../src/lib/http.js', async (original) => ({
  ...(await original<typeof import('../src/lib/http.js')>()),
  fetchWithTimeout: vi.fn(async (url: string) => {
    if (!String(url).includes('chat/completions')) throw new Error(`unexpected call to ${url}`);
    calls += 1;
    if (fail) return new Response('down', { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelJson) } }], usage: { prompt_tokens: 200, completion_tokens: 30 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }),
}));

const { env } = await import('../src/env.js');
const { readTurnWithModel, modelReadingFor, needsModelReading, setModelReadingForTests } = await import('../src/ai/readTurn.js');
const { readReply } = await import('../src/tools/answers.js');
const { asksToAdd, asksToRemove } = await import('../src/tools/cartAuthorization.js');

const sessionId = 'read-turn-test';
let hadKey = '';
beforeEach(() => {
  calls = 0;
  fail = false;
  hadKey = env.openai.apiKey;
  (env.openai as { apiKey: string }).apiKey = 'test-key';
});
afterEach(() => {
  (env.openai as { apiKey: string }).apiKey = hadKey;
});

describe('when a model read is worth it', () => {
  it('a non-English message always; an English one when it answers a question or could be a request', () => {
    expect(needsModelReading('Sí, en talla M', false)).toBe(true);
    expect(needsModelReading('آپ کے پاس ایمبیسڈر بیگز ہیں؟', false)).toBe(true);
    // Any few words may be a request in phrasing the patterns do not know ("what have you got for my legs").
    expect(needsModelReading('show me polos', false)).toBe(true);
    expect(needsModelReading('that one please', true)).toBe(true);
    // A single word answering nothing is not worth a read.
    expect(needsModelReading('hello', false)).toBe(false);
    expect(needsModelReading('   ', true)).toBe(false);
  });
});

describe('the reading, kept for the turn', () => {
  it('a Spanish yes with a size: affirms and M, taken by readReply where the patterns saw nothing', async () => {
    const said = 'Sí, en talla mediana por favor';
    expect(readReply(said).affirms).toBe(false);
    modelJson = { affirms: true, declines: false, size: 'medium', waist: null, leg: null, colours: [], quantity: null, language: 'es' };
    const reading = await readTurnWithModel(said, { sessionId });
    expect(reading).toMatchObject({ affirms: true, size: 'M', language: 'es' });
    const read = readReply(said);
    expect(read.affirms).toBe(true);
    expect(read.size).toBe('M');
    expect(read.remainder).toBe('');
    setModelReadingForTests(said, undefined);
  });

  it('is asked once per wording: the second call is the cache', async () => {
    const said = 'oui, celle-là';
    modelJson = { affirms: true, declines: false, size: null, waist: null, leg: null, colours: [], quantity: null, language: 'fr' };
    await readTurnWithModel(said, { sessionId });
    await readTurnWithModel(said, { sessionId });
    expect(calls).toBe(1);
    expect(modelReadingFor('Oui, celle-là')?.affirms).toBe(true);
    setModelReadingForTests(said, undefined);
  });

  it('only values the code recognises: an invented colour and a nonsense size are dropped, a sane waist kept', async () => {
    const said = 'kamar 34, rang neela aur zorbish';
    modelJson = { affirms: false, declines: false, size: 'gigantic', waist: '34', leg: null, colours: ['blue', 'zorbish'], quantity: 42, language: 'ur' };
    const reading = await readTurnWithModel(said, { sessionId });
    expect(reading).toMatchObject({ waist: '34', colours: ['blue'] });
    expect(reading?.size).toBeUndefined();
    expect(reading?.quantity).toBeUndefined();
    const read = readReply(said);
    expect(read.waist).toBe('34');
    expect(read.colours.map((colour) => colour.word)).toEqual(['blue']);
    setModelReadingForTests(said, undefined);
  });

  it('never overrides what the patterns read: "no, make it L" stays a refusal with L whatever the model says', async () => {
    const said = 'no, make it L';
    modelJson = { affirms: true, declines: false, size: 'M', waist: null, leg: null, colours: ['red'], quantity: null, language: 'en' };
    await readTurnWithModel(said, { sessionId });
    const read = readReply(said);
    expect(read.declines).toBe(true);
    expect(read.affirms).toBe(false);
    expect(read.size).toBe('L');
    setModelReadingForTests(said, undefined);
  });

  it('the model down: null, no reading kept, and the patterns carry on', async () => {
    fail = true;
    const said = 'yes please';
    expect(await readTurnWithModel(said, { sessionId })).toBeNull();
    expect(modelReadingFor(said)).toBeUndefined();
    expect(readReply(said).affirms).toBe(true);
  });

  it('"añádelo" asks to add and "quítalo" to remove, by the reading - never for English words the patterns already judge', async () => {
    modelJson = { affirms: true, declines: false, asksToAdd: true, asksToRemove: false, size: 'M', waist: null, leg: null, colours: ['white'], quantity: null, language: 'es' };
    await readTurnWithModel('Sí, añádelo en blanco', { sessionId });
    expect(asksToAdd('Sí, añádelo en blanco')).toBe(true);
    expect(asksToRemove('Sí, añádelo en blanco')).toBe(false);
    modelJson = { affirms: false, declines: false, asksToAdd: false, asksToRemove: true, size: null, waist: null, leg: null, colours: [], quantity: null, language: 'es' };
    await readTurnWithModel('Quítalo de la cesta', { sessionId });
    expect(asksToRemove('Quítalo de la cesta')).toBe(true);
    modelJson = { affirms: false, declines: false, asksToAdd: true, asksToRemove: false, size: null, waist: null, leg: null, colours: [], quantity: null, language: 'en' };
    await readTurnWithModel('could you set that one aside for me?', { sessionId });
    expect(asksToAdd('could you set that one aside for me?')).toBe(false);
    setModelReadingForTests('Sí, añádelo en blanco', undefined);
    setModelReadingForTests('Quítalo de la cesta', undefined);
    setModelReadingForTests('could you set that one aside for me?', undefined);
  });

  it('no API key: no call at all', async () => {
    (env.openai as { apiKey: string }).apiKey = '';
    expect(await readTurnWithModel('sí', { sessionId })).toBeNull();
    expect(calls).toBe(0);
  });
});
