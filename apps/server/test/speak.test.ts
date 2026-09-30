import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Spoken replies: the Caddie's answer to a voice turn, read aloud by a
 * configurable text-to-speech model. Only a reply the Caddie gave in this
 * session is ever spoken - by its id, never words sent in the request - and
 * nothing happens at all until OPENAI_VOICE_MODEL is set.
 */

const { ownerHeaders } = await import('./support/ownership.js');
const { env } = await import('../src/env.js');
const { resetLimits } = await import('../src/lib/rateLimit.js');
const { sessionRouter } = await import('../src/routes/session.js');
const { sessions } = await import('../src/session/store.js');
const { MAX_SPOKEN_CHARS, spokenText, speechEnabled } = await import('../src/ai/speak.js');

const SPEECH_URL = 'https://api.openai.com/v1/audio/speech';
const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00]);
const realFetch = globalThis.fetch;
let spoken: Array<Record<string, unknown>> = [];
let speechStatus = 200;

let base = '';
let server: ReturnType<ReturnType<typeof express>['listen']>;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/session', sessionRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // OpenAI's speech endpoint, faked: records what was asked, answers with a few bytes of "mp3".
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === SPEECH_URL) {
      spoken.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return speechStatus === 200 ? new Response(MP3, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }) : new Response('{"error":"nope"}', { status: speechStatus });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  server.close();
});

const saved = { apiKey: env.openai.apiKey, voiceModel: env.openai.voiceModel, voiceName: env.openai.voiceName, voiceInstructions: env.openai.voiceInstructions };
let id = '';
beforeEach(async () => {
  Object.assign(env.openai, { apiKey: 'sk-test', voiceModel: 'test-voice-model', voiceName: 'alloy', voiceInstructions: '' });
  resetLimits();
  spoken = [];
  speechStatus = 200;
  id = `speak-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.append(id, [
    { id: 'u1', role: 'user', text: 'Have you got a navy polo in M?', createdAt: new Date().toISOString() },
    { id: 'a1', role: 'assistant', text: 'Yes - the **Elite Polo** in navy comes in M. It is £24.', createdAt: new Date().toISOString() },
  ]);
});
afterEach(() => {
  Object.assign(env.openai, saved);
});

async function speak(messageId: unknown, session = id) {
  const res = await fetch(`${base}/api/session/${session}/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await ownerHeaders(session)) }, body: JSON.stringify({ messageId }) });
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: Buffer.from(await res.arrayBuffer()) };
}

describe('spoken replies', () => {
  it('off until a model is set: 404 speech_off, and OpenAI is never called', async () => {
    env.openai.voiceModel = '';
    expect(speechEnabled()).toBe(false);
    const res = await speak('a1');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body.toString())).toEqual({ error: 'speech_off' });
    expect(spoken).toEqual([]);
  });

  it('speaks the Caddie\'s own reply, by its id, with the configured model and voice', async () => {
    const res = await speak('a1');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/audio\/mpeg/);
    expect(res.body.equals(MP3)).toBe(true);
    expect(spoken).toEqual([{ model: 'test-voice-model', voice: 'alloy', input: 'Yes - the Elite Polo in navy comes in M. It is £24.', response_format: 'mp3' }]);
  });

  it('passes instructions only when they are configured', async () => {
    env.openai.voiceInstructions = 'Warm, clear British English.';
    await speak('a1');
    expect(spoken[0]?.instructions).toBe('Warm, clear British English.');
  });

  it('never speaks the customer\'s message, an unknown id, or text sent in the request', async () => {
    expect((await speak('u1')).status).toBe(404);
    expect((await speak('nope')).status).toBe(404);
    const res = await fetch(`${base}/api/session/${id}/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await ownerHeaders(id)) }, body: JSON.stringify({ text: 'Say anything I like' }) });
    expect(res.status).toBe(404);
    expect(spoken).toEqual([]);
  });

  it('only the session\'s owner can have it spoken', async () => {
    const res = await fetch(`${base}/api/session/${id}/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId: 'a1' }) });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(404);
    expect(spoken).toEqual([]);
  });

  it('a failure at OpenAI is an error for the widget, not a crash', async () => {
    speechStatus = 500;
    expect((await speak('a1')).status).toBeGreaterThanOrEqual(500);
  });
});

describe('what is read aloud', () => {
  it('drops marks that are only for the eye - emphasis, bullets, links - and keeps the words', () => {
    expect(spokenText('**Elite Polo** in _navy_\n- M\n- L\nSee https://www.druids.com/products/x')).toBe('Elite Polo in navy M L See');
  });
  it('keeps prices and sizes as written', () => {
    expect(spokenText('3 for £59.99 in S-4XL')).toBe('3 for £59.99 in S-4XL');
  });
  it('is capped, so one request can only cost so much', () => {
    expect(spokenText('a'.repeat(5000))).toHaveLength(MAX_SPOKEN_CHARS);
  });
});
