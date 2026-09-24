import { SparkleIcon } from './icons.js';

/** The floating "Talk to your Caddie" button, bottom right. */
export function Launcher({ onOpen, basketCount }: { onOpen: () => void; basketCount: number }) {
  return (
    <button type="button" className="caddie-launcher" onClick={onOpen} aria-haspopup="dialog">
      <span className="caddie-launcher__label">Talk to your Caddie</span>
      <span className="caddie-launcher__orb" aria-hidden="true">
        <SparkleIcon size={22} />
        {basketCount > 0 ? <span className="caddie-badge">{basketCount}</span> : null}
      </span>
    </button>
  );
}
