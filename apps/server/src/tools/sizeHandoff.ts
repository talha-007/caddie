/**
 * Sizes are chosen by the customer, on the card - never asked for by the
 * Caddie. Product decision, 29 Sep: the size conversation was where most
 * repeated questions came from ("what size?" as the closing line of every
 * search, asked again after "that is also medium", asked for a polo nobody
 * had asked to buy). The product card and the pack card carry size pickers
 * and an Add button; when an add needs a size, the Caddie says so and the
 * customer picks. A size they say in words is still taken.
 */
// The product page, not the card: the result cards carry no Add button and no picker; View product opens the page where the size is chosen and the theme adds it (Talha, 29 Sep).
export const SIZE_ON_CARD = 'Tap View product to choose your size and add it to your basket.';
export const SIZES_ON_CARDS = 'Tap View product on each to choose your size and add it to your basket.';
export const PACK_SIZES_ON_CARD = 'Choose the sizes on the pack card and tap Add - it goes in as one pack.';

/** A reply that asks the customer for a size, in any of the ways the model does it. */
export const ASKS_SIZE = /\b(what|which)\s+(top |waist |leg )?size\b[^.?!]*\?|\bsize (would|do|should|will) you\b|\bwhat'?s your size\b|\bwhich leg length\b[^.?!]*\?|\bwhat waist\b[^.?!]*\?/i;

/**
 * "Any colour, you pick", "whichever", "surprise me": the customer has handed
 * the choice over. "You can pick me any colour or any design in these two
 * polos and add to cart" was answered "which one would you like me to add?"
 * (live, 29 Sep). A choice they delegate is made - the first that fits, on
 * screen - never one they did not delegate.
 */
const DELEGATES = /\b(any (colou?r|color|design|one|of (them|these|those))|you (can |could |may )?(pick|choose|decide|select)( (one|any|for me|whichever))?|whichever|doesn'?t matter|don'?t mind|no preference|up to you|your (pick|choice|call)|surprise me)\b/i;
export function delegatesChoice(said: string): boolean {
  return DELEGATES.test(said);
}
