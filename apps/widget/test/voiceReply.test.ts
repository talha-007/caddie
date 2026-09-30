import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Spoken replies on the widget's side: a voice turn's reply is fetched by its
 * message id and played; one reply at a time; listening again stops it; and a
 * server with spoken replies off is not asked again.
 */

/** A stand-in for the browser's Audio: jsdom has no media playback. */
class FakeAudio extends EventTarget {
  static made: FakeAudio[] = [];
  paused = true;
  constructor(public src: string) {
    super();
    FakeAudio.made.push(this);
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  finish() {
    this.paused = true;
    this.dispatchEvent(new Event('ended'));
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  FakeAudio.made = [];
  vi.stubGlobal('Audio', FakeAudio);
  URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`);
  URL.revokeObjectURL = vi.fn();
  sessionStorage.clear();
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

describe('the player', () => {
  it('plays a clip and tidies up when it ends', async () => {
    const { isReplyPlaying, playReply } = await import('../src/lib/voiceReply.js');
    const done = playReply(new Blob(['mp3']));
    expect(FakeAudio.made).toHaveLength(1);
    expect(FakeAudio.made[0]!.paused).toBe(false);
    expect(isReplyPlaying()).toBe(true);
    FakeAudio.made[0]!.finish();
    await done;
    expect(isReplyPlaying()).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('one reply at a time: a new one stops the last', async () => {
    const { playReply } = await import('../src/lib/voiceReply.js');
    void playReply(new Blob(['one']));
    void playReply(new Blob(['two']));
    expect(FakeAudio.made[0]!.paused).toBe(true);
    expect(FakeAudio.made[1]!.paused).toBe(false);
  });

  it('stopReply (the mic pressed, the panel closed, a new chat) stops it at once', async () => {
    const { isReplyPlaying, playReply, stopReply } = await import('../src/lib/voiceReply.js');
    const done = playReply(new Blob(['mp3']));
    stopReply();
    await done;
    expect(FakeAudio.made[0]!.paused).toBe(true);
    expect(isReplyPlaying()).toBe(false);
  });

  it('a browser that refuses to play resolves quietly - the reply is still on screen', async () => {
    class Blocked extends FakeAudio {
      override play() {
        return Promise.reject(new Error('NotAllowedError'));
      }
    }
    vi.stubGlobal('Audio', Blocked);
    const { isReplyPlaying, playReply } = await import('../src/lib/voiceReply.js');
    await playReply(new Blob(['mp3']));
    expect(isReplyPlaying()).toBe(false);
  });
});

describe('fetching the spoken reply', () => {
  let calls: Array<{ url: string; body: string }>;
  let speakReply: () => Response;
  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/claim')) return json(200, { sessionId: 's1', sessionToken: 'tok', contract: 'cart-ops/1' });
      if (url.endsWith('/speak')) {
        calls.push({ url, body: String(init?.body) });
        return speakReply();
      }
      return json(404, {});
    }) as typeof fetch;
  });

  it('asks by message id, never by words, and gets the audio back', async () => {
    speakReply = () => new Response(new Blob(['mp3']), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    const { speakMessage } = await import('../src/lib/api.js');
    const clip = await speakMessage('s1', 'm-42');
    expect(clip).not.toBeNull();
    expect(JSON.parse(calls[0]!.body)).toEqual({ messageId: 'm-42' });
  });

  it('spoken replies off on this server: null, and it is not asked again', async () => {
    speakReply = () => json(404, { error: 'speech_off' });
    const { speakMessage } = await import('../src/lib/api.js');
    expect(await speakMessage('s1', 'm-1')).toBeNull();
    expect(await speakMessage('s1', 'm-2')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('a reply that cannot be spoken (unknown, or a server error): null, and the next one is still tried', async () => {
    speakReply = () => json(404, { error: 'unknown_message' });
    const { speakMessage } = await import('../src/lib/api.js');
    expect(await speakMessage('s1', 'm-1')).toBeNull();
    speakReply = () => json(502, { error: 'upstream' });
    expect(await speakMessage('s1', 'm-2')).toBeNull();
    expect(calls).toHaveLength(2);
  });
});
