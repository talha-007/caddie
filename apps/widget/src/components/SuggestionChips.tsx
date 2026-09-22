import type { CaddieAttachment } from '@caddie/shared';

/**
 * The follow-ups under the conversation ("Show me cheaper", "Change the
 * colour"). They are sent as plain sentences, exactly as if spoken, so the
 * Caddie's memory of the conversation does the rest.
 */
const BY_KIND: Record<CaddieAttachment['kind'] | 'start', string[]> = {
  start: ['What size should I buy?', 'Build me an outfit under £150', 'Recommend a pack for mixed conditions'],
  products: ['Show me a cheaper option', 'Show me other colours', 'What goes with this?'],
  size: ["What's the fit like?", 'Show me other colours', 'Build me an outfit in my size'],
  pack: ['Show me a cheaper option', 'Change the colours', 'Add a jacket'],
  outfit: ['Show me a cheaper option', 'Change the polo to navy', 'Add a layer'],
  cart: ['Build me an outfit under £150', 'Recommend a pack for mixed conditions'],
};

export function SuggestionChips({
  last,
  disabled,
  onPick,
}: {
  last: CaddieAttachment['kind'] | null;
  disabled: boolean;
  onPick: (text: string) => void;
}) {
  const chips = BY_KIND[last ?? 'start'];
  return (
    <div className="caddie-suggestions" role="group" aria-label="Suggestions">
      {chips.map((chip) => (
        <button key={chip} type="button" className="caddie-suggestion" disabled={disabled} onClick={() => onPick(chip)}>
          {chip}
        </button>
      ))}
    </div>
  );
}
