import { useEffect, useRef } from 'react';
import { SparkleIcon } from './icons.js';

/** Clear space kept between the launcher and whatever it moved above. */
const GAP = 12;
/** Never climb further than this share of the screen, whatever is below. */
const MAX_LIFT_SHARE = 0.4;
/** Floating buttons from other apps arrive late; look again for a while. */
const RECHECK_MS = [600, 1500, 3000, 6000, 12000];

/**
 * The fixed element a point on the screen belongs to, if any - the thing
 * that floats rather than scrolls. Ours never counts.
 */
function floatingAncestor(element: Element, own: Element): HTMLElement | null {
  for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
    if (own.contains(node) || node.contains(own)) return null;
    const style = getComputedStyle(node);
    if (style.position === 'fixed' || style.position === 'sticky') {
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return null;
      return node as HTMLElement;
    }
  }
  return null;
}

/**
 * How far to lift the launcher so nothing floating covers it.
 *
 * On the live Druids theme a "FOLLOW DRUIDS" Instagram button sits in the
 * same bottom-right corner and hid the Caddie completely. A fixed offset
 * only fixes that one theme on that one day - every app a store installs
 * brings its own floating button - so the launcher looks at what is actually
 * under it and moves just above it.
 */
function liftNeeded(button: HTMLElement): number {
  const ours = button.getBoundingClientRect();
  if (ours.width === 0) return 0;
  let lift = 0;
  const xs = [ours.left + 4, ours.left + ours.width / 2, ours.right - 4];
  const ys = [ours.top + 4, ours.top + ours.height / 2, ours.bottom - 4];
  for (const x of xs) {
    for (const y of ys) {
      for (const hit of document.elementsFromPoint(x, y)) {
        const other = floatingAncestor(hit, button);
        if (!other) continue;
        const rect = other.getBoundingClientRect();
        // A full-width bar (sticky add-to-cart) or a small badge alike: sit above it.
        lift = Math.max(lift, ours.bottom - rect.top + GAP);
      }
    }
  }
  return Math.min(lift, window.innerHeight * MAX_LIFT_SHARE);
}

/** The floating "Talk to your Caddie" button, bottom right. */
export function Launcher({ onOpen, basketCount }: { onOpen: () => void; basketCount: number }) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const button = ref.current;
    if (!button) return;

    // A theme can pin the height itself: <div id="druids-caddie" data-launcher-offset="96">.
    const pinned = Number(document.getElementById('druids-caddie')?.dataset.launcherOffset);
    if (Number.isFinite(pinned) && pinned > 0) {
      button.style.setProperty('--caddie-launcher-offset', `${pinned}px`);
      return;
    }

    const place = () => {
      // Measured from the resting position, so it also comes back down when
      // the other button goes away.
      button.style.setProperty('--caddie-lift', '0px');
      const lift = liftNeeded(button);
      button.style.setProperty('--caddie-lift', `${Math.round(lift)}px`);
    };

    place();
    const timers = RECHECK_MS.map((ms) => setTimeout(place, ms));
    window.addEventListener('resize', place);
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener('resize', place);
    };
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
