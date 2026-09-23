import { describe, expect, it } from 'vitest';
import type { CaddieMessage } from '@caddie/shared';
import { MemorySessionStore } from '../src/session/store.js';

/**
 * The contract both stores have to keep.
 *
 * `append` exists because of a bug that only appeared once sessions were in
 * Redis: a route read the session, the model's tools wrote to it during the
 * turn, and then the route saved the copy it had read at the start - undoing
 * every one of them. In memory it happened to work, because both held the
 * same object.
 */

function message(text: string): CaddieMessage {
  return { id: crypto.randomUUID(), role: 'user', text, createdAt: new Date().toISOString() };
}

describe('session store contract', () => {
  it('append does not undo what was patched during the turn', async () => {
    const store = new MemorySessionStore();

    // A route reads the session at the start of a turn.
    const readAtStart = await store.getOrCreate('s1');
    expect(readAtStart.messages).toHaveLength(0);

    // The model's tools write to it while the turn is running.
    await store.patch('s1', { sizeProfile: { chestCm: 107 }, cartId: 'gid://shopify/Cart/1' });

    // The route then records what was said.
    await store.append('s1', [message('what size am I?')]);

    const after = await store.get('s1');
    expect(after?.sizeProfile.chestCm).toBe(107);
    expect(after?.cartId).toBe('gid://shopify/Cart/1');
    expect(after?.messages).toHaveLength(1);
  });

  it('keeps history in order across several turns', async () => {
    const store = new MemorySessionStore();
    await store.append('s2', [message('one')]);
    await store.append('s2', [message('two')]);
    await store.append('s2', [message('three')]);

    const session = await store.get('s2');
    expect(session?.messages.map((m) => m.text)).toEqual(['one', 'two', 'three']);
  });

  it('never stores an attachment in history', async () => {
    const store = new MemorySessionStore();
    const heavy: CaddieMessage = {
      id: '1', role: 'assistant', text: 'Here you go.', createdAt: new Date().toISOString(),
      attachment: { kind: 'products', products: [] },
    };

    await store.append('s3', [heavy]);
    const session = await store.get('s3');
    expect(session?.messages[0]?.attachment).toBeUndefined();
    expect(session?.messages[0]?.text).toBe('Here you go.');
  });
});
