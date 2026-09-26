import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '@caddie/shared';
import { phoneticEnglish } from '../src/ai/phoneticEnglish.js';
import { expectedScripts } from '../src/ai/language.js';
import { transcribeHeard } from '../src/ai/transcribe.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';

/**
 * "Hey Caddie, choose me an Ambassador Pack", said in English with a
 * Pakistani accent, reached the Caddie as "اے کیڈی، چوز می این ایمبیسیڈر پیک"
 * and was answered in Urdu. English in Urdu letters is English; Urdu is Urdu,
 * and must never be rewritten into English it does not say.
 */

function product(title: string): Product {
  return {
    id: `gid://shopify/Product/${title.replace(/\W+/g, '-')}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: 'JACKETS',
    tags: [],
    price: { amount: 68, currency: 'GBP' },
    options: [],
    variants: [],
    description: null,
  };
}

beforeEach(() => setCatalogueForTests([product('TEX RAIN JACKET - BLACK'), product('ELITE POLO - NAVY'), product('GOLF TEE POLO - WHITE')]));

describe('English written in Urdu letters', () => {
  it('the sentence that started this', () => {
    expect(phoneticEnglish('اے کیڈی، چوز می این ایمبیسیڈر پیک')?.normalised).toBe('Hey Caddie, choose me an Ambassador Pack');
    expect(phoneticEnglish('اے کیڈی، چوز می این ایمبیسیڈر پیک.')?.normalised).toBe('Hey Caddie, choose me an Ambassador Pack.');
  });

  it("the transcription model's own spellings, as whisper-1 wrote accented English", () => {
    expect(phoneticEnglish('ہے کیٹی چیوز می این ایمباسیٹر پیک')?.normalised).toBe('Hey Caddie choose me an Ambassador Pack');
    expect(phoneticEnglish('اڈ میڈیم ون')?.normalised).toBe('Add medium one');
  });

  it('"ہے" is "hey" only first and before the name; anywhere else it is Urdu', () => {
    expect(phoneticEnglish('شو می ہے')).toBeNull();
    expect(phoneticEnglish('ہے چوز می')).toBeNull();
  });

  it('English translated into real Urdu is Urdu - only hearing it again could recover it', () => {
    expect(phoneticEnglish('مجھے دکھائیں کہ آپ کے لئے بہت بہترین رینی جاکٹ ہے۔')).toBeNull();
    expect(phoneticEnglish('میری نیوی میں ایک ایلیٹ پولو دکھائیں')).toBeNull();
  });

  it('a product request, with the name as the catalogue spells it', () => {
    expect(phoneticEnglish('شو می دی ٹیکس رین جیکٹ')?.normalised).toBe('Show me the Tex Rain Jacket');
    expect(phoneticEnglish('شو می این ایلیٹ پولو')?.normalised).toBe('Show me an Elite Polo');
  });

  it('English typed or heard in English letters is left alone', () => {
    expect(phoneticEnglish('Hey Caddie, choose me an Ambassador Pack.')).toBeNull();
  });
});

describe('genuine Urdu is never rewritten', () => {
  it.each([
    'مجھے بارش کے لیے جیکٹ دکھاؤ',
    'مجھے جیکٹ دکھاؤ',
    'بارش کے لیے کچھ چاہیے',
    'میرا سائز ایکس ایل ہے',
    'مجھے ایمبیسیڈر پیک دکھاؤ',
  ])('%s', (urdu) => {
    expect(phoneticEnglish(urdu)).toBeNull();
  });

  it('a mixed sentence keeps its product name and its Urdu', () => {
    expect(phoneticEnglish('مجھے Elite Polo navy میں دکھاؤ')).toBeNull();
  });

  it('shared loanwords alone do not make it English', () => {
    expect(phoneticEnglish('جیکٹ پیک')).toBeNull();
    expect(phoneticEnglish('بلیک پولو')).toBeNull();
  });

  it('a word it cannot read leaves the whole transcript alone', () => {
    expect(phoneticEnglish('شو می دی قمیض')).toBeNull();
  });
});

describe('one misheard sentence does not make Urdu "expected" afterwards', () => {
  it('earlier phonetic English counts as English', () => {
    const scripts = expectedScripts({ languages: ['en-GB'], earlier: ['اے کیڈی، چوز می این ایمبیسیڈر پیک'] });
    expect([...scripts]).toEqual(['latin']);
  });

  it('earlier genuine Urdu still counts as Urdu', () => {
    const scripts = expectedScripts({ languages: ['en-GB'], earlier: ['مجھے جیکٹ دکھاؤ'] });
    expect(scripts.has('arabic')).toBe(true);
  });
});

/*
 * The voice path end to end, with the provider replaced: what it is asked
 * for and what the Caddie is given.
 */
describe('transcription, heard again in English when it was English', () => {
  const clip = Buffer.alloc(20_000, 1);
  let calls: Array<string | null>;
  let replies: string[];
  const original = env.openai.apiKey;

  beforeEach(() => {
    calls = [];
    (env.openai as { apiKey: string }).apiKey = 'test-key';
    vi.stubGlobal('fetch', async (_url: string, init: { body: FormData }) => {
      calls.push((init.body.get('language') as string | null) ?? null);
      return new Response(JSON.stringify({ text: replies[calls.length - 1] ?? '' }), { status: 200 });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    (env.openai as { apiKey: string }).apiKey = original;
  });

  const hints = { languages: ['en-GB', 'ur-PK'], earlier: [] };

  it('Urdu letters for English speech: heard again in English, and English reaches the Caddie', async () => {
    replies = ['اے کیڈی، چوز می این ایمبیسیڈر پیک', 'Hey Caddie, choose me an Ambassador Pack.'];
    const heard = await transcribeHeard(clip, 'audio/webm', { hints });
    expect(calls).toEqual([null, 'en']);
    expect(heard).toMatchObject({
      rawTranscript: 'اے کیڈی، چوز می این ایمبیسیڈر پیک',
      normalizedTranscript: 'Hey Caddie, choose me an Ambassador Pack.',
      detectedLanguage: 'ur',
      replyLanguage: 'en',
      normalizedBy: 'heard-again-in-english',
    });
  });

  it('if hearing it in English fails, the word-by-word reading is used', async () => {
    replies = ['شو می دی ٹیکس رین جیکٹ', 'شو می دی ٹیکس رین جیکٹ'];
    const heard = await transcribeHeard(clip, 'audio/webm', { hints });
    expect(heard.normalizedTranscript).toBe('Show me the Tex Rain Jacket');
    expect(heard.normalizedBy).toBe('transliterated');
    expect(heard.replyLanguage).toBe('en');
  });

  it('genuine Urdu from an Urdu-speaking browser: heard once, left as Urdu', async () => {
    replies = ['مجھے بارش کے لیے جیکٹ دکھاؤ'];
    const heard = await transcribeHeard(clip, 'audio/webm', { hints });
    expect(calls).toEqual([null]);
    expect(heard.normalizedTranscript).toBe('مجھے بارش کے لیے جیکٹ دکھاؤ');
    expect(heard.replyLanguage).toBe('ur');
    expect(heard.normalizedBy).toBeUndefined();
  });

  it('English heard as English: one call, unchanged', async () => {
    replies = ['Show me an Elite Polo in navy.'];
    const heard = await transcribeHeard(clip, 'audio/webm', { hints });
    expect(calls).toEqual([null]);
    expect(heard).toMatchObject({ normalizedTranscript: 'Show me an Elite Polo in navy.', detectedLanguage: 'en', replyLanguage: 'en' });
  });
});
