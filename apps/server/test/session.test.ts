import { describe, expect, it } from 'vitest';
import { MemorySessionStore } from '../src/session/store.js';

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
