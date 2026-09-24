import type { CaddieAttachment } from '@caddie/shared';

/**
 * "Try saying…" - example phrases, not chat chips.
 *
 * They are sent as plain sentences, exactly as if spoken, so the Caddie's
 * memory of the conversation does the rest. Presented as quiet suggestions so
 * nothing here reads as a text box: speaking is the way in.
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
  const phrases = BY_KIND[last ?? 'start'];
  return (
    <div className="caddie-trysay" role="group" aria-label="Things you can say">
      <p className="caddie-trysay__label">Try saying</p>
      <div className="caddie-trysay__list">
        {phrases.map((phrase) => (
          <button key={phrase} type="button" className="caddie-trysay__item" disabled={disabled} onClick={() => onPick(phrase)}>
            <span aria-hidden="true">“</span>
            {phrase}
            <span aria-hidden="true">”</span>
          </button>
        ))}
      </div>
    </div>
  );
}
