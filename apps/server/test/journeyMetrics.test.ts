import { describe, expect, it } from 'vitest';
import { journeyOf } from '../src/usage/report.js';

/**
 * The three journey figures on the dashboard, read off a transcript: whether
 * a basket change went out, how many customer turns it took, and questions
 * the Caddie asked twice in one conversation.
 */
describe('journey figures from a transcript', () => {
  it('a conversation that reached the basket on the third customer turn', () => {
    const journey = journeyOf([
      { role: 'user', text: 'show me polos' },
      { role: 'assistant', text: "I'd start with the Elite Polo. Want me to add it?" },
      { role: 'user', text: 'in medium' },
      { role: 'assistant', text: 'Which colour would you like?' },
      { role: 'user', text: 'white' },
      { role: 'assistant', text: 'Updating your basket…' },
      { role: 'assistant', text: 'Added the white Elite Polo in M.' },
    ]);
    expect(journey).toEqual({ reachedBasket: true, turnsToBasket: 3, repeatedQuestions: 0 });
  });

  it('a conversation that never got there, with the same question asked twice', () => {
    const journey = journeyOf([
      { role: 'user', text: 'what size am I? 5 foot 10, 80 kilos' },
      { role: 'assistant', text: 'Is that for the mens or the womens range?' },
      { role: 'user', text: 'show me polos in that size' },
      { role: 'assistant', text: 'Is that for the mens or the womens range?' },
      { role: 'user', text: 'mens' },
      { role: 'assistant', text: 'You are an M. Shall I add the Elite Polo?' },
    ]);
    expect(journey).toEqual({ reachedBasket: false, turnsToBasket: null, repeatedQuestions: 1 });
  });

  it('a removal counts as reaching the basket; a very short question fragment never counts as repeated', () => {
    const journey = journeyOf([
      { role: 'user', text: 'remove the jacket' },
      { role: 'assistant', text: 'Removed the Clima Jacket 3.0 from your basket. OK? OK?' },
    ]);
    expect(journey).toEqual({ reachedBasket: true, turnsToBasket: 1, repeatedQuestions: 0 });
  });
});
