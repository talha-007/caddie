/**
 * The Caddie's reply to a voice turn, played aloud. One reply at a time: a
 * new one replaces the last, and anything that starts listening again - the
 * mic pressed, the panel closed, a new chat - stops it first, so the Caddie
 * is never recorded talking over itself into the customer's next clip.
 */

let current: { audio: HTMLAudioElement; url: string } | null = null;

export function stopReply(): void {
  if (!current) return;
  const { audio, url } = current;
  current = null;
  try {
    audio.pause();
  } catch {
    // Nothing to stop.
  }
  URL.revokeObjectURL(url);
}

export function isReplyPlaying(): boolean {
  return current !== null;
}

/**
 * Plays the clip. Resolves when it has finished, been stopped, or could not
 * play (a browser that blocks audio without a tap): a reply that is not
 * heard is still on screen, so failing quietly loses nothing.
 */
export function playReply(clip: Blob): Promise<void> {
  stopReply();
  if (typeof Audio === 'undefined' || typeof URL.createObjectURL !== 'function') return Promise.resolve();
  const url = URL.createObjectURL(clip);
  const audio = new Audio(url);
  const mine = { audio, url };
  current = mine;
  return new Promise<void>((resolve) => {
    const done = () => {
      if (current === mine) stopReply();
      resolve();
    };
    audio.addEventListener('ended', done, { once: true });
    audio.addEventListener('error', done, { once: true });
    audio.addEventListener('pause', () => resolve(), { once: true });
    const started = audio.play();
    if (started && typeof started.catch === 'function') started.catch(done);
  });
}
