import { noteShoppingFocus } from '../session/focus.js';
import { currentMission, currentPack } from '../session/shoppingSession.js';
import { sessions } from '../session/store.js';
import { acceptedRecommendation } from '../shopper/facts.js';
import { noteCustomerWords } from '../shopper/remember.js';
import { packPieces, readPackChoices } from '../tools/packState.js';
import { revalidatePack, type PackRevalidation } from '../tools/index.js';

/**
 * One customer message, read by code before the model runs - so every tool
 * this turn already sees what it said. In this order:
 *
 *   1. what it says about them, and what it asks of this shopping
 *      (shopper/remember.ts)
 *   2. what they are shopping for now - the focus, its mission and the pack
 *      in hand (session/focus.ts)
 *   3. a choice for the pack in hand - "waist 34, leg 36", a bare "34"
 *      (tools/packState.ts). After the focus, so a message that leaves the
 *      pack ("show me polos") never hands its numbers to it.
 *   4. a size recommendation accepted ("use that size"), kept for purchases
 *      in this mission (tools/searchIntent.ts)
 *   5. the pack in hand checked again with what is now known (below)
 */
export async function readCustomerTurn(sessionId: string, userText: string): Promise<{ revalidated?: PackRevalidation }> {
  await noteCustomerWords(sessionId, userText);
  await noteShoppingFocus(sessionId, userText);

  const now = await sessions.getOrCreate(sessionId);
  const accepted = acceptedRecommendation(now, userText);
  // Only the pack in hand: an old pack still on screen, or built three requests ago, does not take a bare "34".
  const handle = currentPack(now);
  if (handle) {
    const pieces = packPieces(now, handle);
    const lastReply = [...now.messages].reverse().find((message) => message.role === 'assistant')?.text ?? '';
    const current = now.packChoices?.[handle] ?? {};
    // "Use that size", straight after we recommended one: their acceptance, so it counts as theirs for this pack.
    const next = readPackChoices(userText, lastReply, pieces, current, accepted ? { [accepted.scale]: accepted.size } : undefined);
    if (JSON.stringify(next) !== JSON.stringify(current)) await sessions.patch(sessionId, { packChoices: { ...(now.packChoices ?? {}), [handle]: next } });
  }
  if (accepted && accepted.acceptedMission !== currentMission(now)) {
    await sessions.patch(sessionId, { sizeRecommendation: { ...accepted, acceptedMission: currentMission(now) } });
  }
  /*
   * 5. the pack in hand checked again against what is now known - a piece
   *    sold out in the size just given is replaced before anything is said
   *    (tools/index.ts revalidatePack).
   */
  const revalidated = handle ? await revalidatePack(sessionId, userText) : null;
  return revalidated ? { revalidated } : {};
}
