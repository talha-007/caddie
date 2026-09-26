import { useEffect, useRef } from 'react';
import { SparkleIcon } from './icons.js';

/**
 * The floating "Talk to your Caddie" button, bottom right.
 *
 * It sits at one fixed height, just above the theme's "FOLLOW DRUIDS" button
 * in the same corner (--caddie-launcher-offset in styles.css). It used to
 * measure what was floating beneath it and climb above it; with a "Your look
 * is ready" tab further up the same edge, it climbed straight behind that on
 * some visits and not on others. One known place is better than a clever one.
 */
export function Launcher({ onOpen, basketCount }: { onOpen: () => void; basketCount: number }) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // A theme can still set the height itself: <div id="druids-caddie" data-launcher-offset="96">.
    const pinned = Number(document.getElementById('druids-caddie')?.dataset.launcherOffset);
    if (ref.current && Number.isFinite(pinned) && pinned > 0) {
      ref.current.style.setProperty('--caddie-launcher-offset', `${pinned}px`);
    }
  }, []);

  return (
    <button ref={ref} type="button" className="caddie-launcher" onClick={onOpen} aria-haspopup="dialog">
      <span className="caddie-launcher__label">Talk to your Caddie</span>
      <span className="caddie-launcher__orb" aria-hidden="true">
        <SparkleIcon size={22} />
        {basketCount > 0 ? <span className="caddie-badge">{basketCount}</span> : null}
      </span>
    </button>
  );
}
