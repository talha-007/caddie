import { describe, expect, it } from 'vitest';
import { impossibleSpeechRate } from '../src/ai/transcribe.js';

/**
 * A customer tapped the mic, said nothing, and the Caddie received:
 *
 *   "I need a medium polo, a large midlayer, and an extra-large gilet."
 *
 * Every noun and size in it came from the biasing prompt we send with the
 * audio - polos, midlayers, gilets, S, M, L, XL. Given silence, the model
 * handed our own vocabulary back as a fluent order, and the Caddie went
 * looking for those garments. One step further and it would have been a
 * basket the customer never asked for.
 *
 * The prompt is a bare word list now rather than a sentence, and this is the
 * check for whatever still gets through. It counts words against the length
 * of the clip, because the text itself is not the tell - "I need a medium
 * polo" is something a real customer says. Saying it in a fifth of a second
 * is not.
 */
describe('a transcript longer than the audio could hold', () => {
  it('rejects the sentence that started this', () => {
    const phantom = 'I need a medium polo, a large midlayer, and an extra-large gilet.';
    expect(impossibleSpeechRate(phantom, 0.4)).toBe(true);
  });

  it('accepts the same sentence when it was actually spoken', () => {
    const real = 'I need a medium polo, a large midlayer, and an extra-large gilet.';
    expect(impossibleSpeechRate(real, 5)).toBe(false);
  });

  it('accepts ordinary speech at an ordinary pace', () => {
    expect(impossibleSpeechRate('show me a navy polo please', 2)).toBe(false);
    expect(impossibleSpeechRate('what size am I in mens', 1.8)).toBe(false);
  });

  it('accepts a fast talker', () => {
    // Twelve words in three seconds is four a second - quick, not impossible.
    expect(impossibleSpeechRate('I am looking for a navy polo and some shorts as well', 3)).toBe(false);
  });

  /* A clipped "yes" or "cheaper" is the most common thing anyone says. */
  it('never refuses a one or two word answer', () => {
    expect(impossibleSpeechRate('yes', 0.2)).toBe(false);
    expect(impossibleSpeechRate('the navy', 0.3)).toBe(false);
  });

  it('says nothing about an empty transcript', () => {
    expect(impossibleSpeechRate('', 0.5)).toBe(false);
  });

  it('does not divide by a zero-length clip', () => {
    expect(impossibleSpeechRate('a whole sentence of words here', 0)).toBe(false);
  });
});
