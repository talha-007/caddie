import { describe, expect, it } from 'vitest';
import { MemorySessionStore, stateOf } from '../src/session/store.js';

describe('MemorySessionStore', () => {
  it('remembers measurements across turns', async () => {
    const store = new MemorySessionStore();
    await store.patch('s1', { sizeProfile: { heightValue: 180, heightUnit: 'cm' } });
    await store.patch('s1', { sizeProfile: { weightValue: 80, weightUnit: 'kg' } });

    const session = await store.get('s1');
    expect(session?.sizeProfile).toMatchObject({ heightValue: 180, weightValue: 80 });
  });

  it('does not unset a preference with an undefined patch', async () => {
    const store = new MemorySessionStore();
    await store.patch('s2', { preferences: { colour: 'navy', budgetAmount: 150 } });
    await store.patch('s2', { preferences: { colour: undefined, budgetAmount: 120 } });

    const session = await store.get('s2');
    expect(session?.preferences.colour).toBe('navy');
    expect(session?.preferences.budgetAmount).toBe(120);
  });

  it('keeps one object per session so a later save cannot undo a patch', async () => {
    const store = new MemorySessionStore();
    // A route grabs the session, a tool patches it, then the route saves.
    const held = await store.getOrCreate('s3');
    await store.patch('s3', { cartId: 'cart-123' });
    held.messages.push({ id: 'm1', role: 'user', text: 'hi', createdAt: new Date().toISOString() });
    await store.save(held);

    const session = await store.get('s3');
    expect(session?.cartId).toBe('cart-123');
    expect(session?.messages).toHaveLength(1);
  });
});

/**
 * The backend is stateless: the client holds the conversation and sends it
 * back, so a message can land on an instance that has never seen the customer.
 * These pin the two things that would break that quietly.
 */
describe('restoring a conversation the client sent back', () => {
  it('knows a customer the instance has never seen', async () => {
    const store = new MemorySessionStore();

    const session = await store.restore('never-seen', {
      sizeProfile: { usualSize: 'M', audience: 'men' },
      preferences: { colour: 'navy', budgetAmount: 150 },
      messages: [{ id: 'm1', role: 'user', text: 'a navy polo', createdAt: '2026-09-24T10:00:00Z' }],
    });

    expect(session.sizeProfile.usualSize).toBe('M');
    expect(session.preferences.colour).toBe('navy');
    expect(session.messages).toHaveLength(1);
  });

  /*
   * Replaced, not merged. Anything this instance still holds is a leftover
   * from an earlier turn it happened to serve; merging would resurrect a
   * budget or a colour the customer has already moved on from.
   */
  it('replaces what the instance was holding rather than merging it', async () => {
    const store = new MemorySessionStore();
    await store.patch('rotate', { preferences: { colour: 'navy', budgetAmount: 150 } });

    const session = await store.restore('rotate', {
      sizeProfile: {},
      preferences: { budgetAmount: 80 },
      messages: [],
    });

    expect(session.preferences.budgetAmount).toBe(80);
    expect(session.preferences.colour).toBeUndefined();
  });

  it('hands back only the remembered part, not the bookkeeping', async () => {
    const store = new MemorySessionStore();
    const session = await store.getOrCreate('s');
    const state = stateOf(session);

    expect(state).not.toHaveProperty('id');
    expect(state).not.toHaveProperty('createdAt');
    expect(state).not.toHaveProperty('updatedAt');
    expect(state).toHaveProperty('messages');
  });

  /* A payload is rendered once and never read again; carrying it would make
   * every request an order of magnitude larger for nothing. */
  it('does not hand attachments back to the client', async () => {
    const store = new MemorySessionStore();
    await store.append('a', [
      {
        id: 'm1',
        role: 'assistant',
        text: 'here you go',
        createdAt: '2026-09-24T10:00:00Z',
        attachment: { kind: 'products', products: [] },
      },
    ]);

    const state = stateOf(await store.getOrCreate('a'));
    expect(state.messages[0]).not.toHaveProperty('attachment');
  });
});
