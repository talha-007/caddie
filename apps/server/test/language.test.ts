import { describe, expect, it } from 'vitest';
import {
  dominantScript,
  expectedScripts,
  languageToRetry,
  parseLanguageList,
} from '../src/ai/language.js';

/**
 * Voice is transcribed with the language detected, then checked. These pin
 * down the check: the case that started it was an English sentence in a South
 * Asian accent, from a shopper on an English page, returned in Urdu script.
 */

const URDU_MISHEARING = 'میرا سینہ 36 سینٹی میٹر ہے، آپ کیا تجویز کرتے ہیں؟';

describe('dominantScript', () => {
  it('reads the script of the letters, not the digits', () => {
    expect(dominantScript(URDU_MISHEARING)).toBe('arabic');
    expect(dominantScript('My chest is 36 inches')).toBe('latin');
    expect(dominantScript('मेरा साइज़ क्या है')).toBe('devanagari');
    expect(dominantScript('36')).toBeNull();
  });

  it('is not swayed by a product name inside another language', () => {
    expect(dominantScript('مجھے ORIENT POLO چاہیے، کیا یہ دستیاب ہے اور کتنے کا ہے')).toBe('arabic');
  });
});

describe('languageToRetry', () => {
  it('re-hears Urdu script from a shopper on an English page', () => {
    expect(languageToRetry(URDU_MISHEARING, { languages: ['en-GB', 'en'], earlier: [] })).toBe('en');
  });

  it('keeps Urdu when the shopper asks for Urdu', () => {
    expect(languageToRetry(URDU_MISHEARING, { languages: ['ur-PK', 'en'], earlier: [] })).toBeNull();
  });

  it('keeps Urdu when the shopper has already written in it', () => {
    const earlier = ['میں ایک پولو ڈھونڈ رہا ہوں'];
    expect(languageToRetry(URDU_MISHEARING, { languages: ['en-GB'], earlier })).toBeNull();
  });

  it('never second-guesses another language in the same script', () => {
    // Spanish from an English browser is Latin either way: not a misdetection we can see.
    expect(languageToRetry('Quiero un polo azul talla M', { languages: ['en-GB'], earlier: [] })).toBeNull();
  });

  it('does nothing when it knows nothing about the shopper', () => {
    expect(languageToRetry(URDU_MISHEARING, { languages: [], earlier: [] })).toBeNull();
  });

  it('never forces a Latin transcript into another script', () => {
    // An English speaker on an Urdu-language page is ordinary.
    expect(languageToRetry('My chest is 36 inches', { languages: ['ur'], earlier: [] })).toBeNull();
  });

  it('retries in the first language the shopper named', () => {
    expect(languageToRetry('Мой размер M', { languages: ['de-DE', 'en'], earlier: [] })).toBe('de');
  });
});

describe('parseLanguageList', () => {
  it('reads an Accept-Language header in preference order', () => {
    expect(parseLanguageList('en-GB,en;q=0.9,ur;q=0.8')).toEqual(['en-GB', 'en', 'ur']);
  });

  it('drops junk rather than trust it', () => {
    expect(parseLanguageList('*,en,<script>')).toEqual(['en']);
    expect(parseLanguageList(undefined)).toEqual([]);
  });

  it('maps unlisted languages to Latin', () => {
    expect([...expectedScripts({ languages: ['fr'], earlier: [] })]).toEqual(['latin']);
  });
});
