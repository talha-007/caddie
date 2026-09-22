import { useState } from 'react';
import type { VoiceState } from '../lib/useVoice.js';
import { SendIcon } from './icons.js';
import { VoiceButton } from './VoiceButton.js';

interface ComposerProps {
  disabled: boolean;
  voice: VoiceState;
  onSend: (text: string) => void;
}

/** Type or talk: the text box, send, and the mic at the bottom right where a thumb reaches. */
export function Composer({ disabled, voice, onSend }: ComposerProps) {
  const [value, setValue] = useState('');
  const canSend = !disabled && value.trim().length > 0;

  return (
    <form
      className="caddie-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSend) return;
        onSend(value);
        setValue('');
      }}
    >
      <div className="caddie-composer__field">
        <input
          type="text"
          className="caddie-input caddie-composer__input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={voice.active ? 'Or type instead…' : 'Type a message…'}
          aria-label="Message the Caddie"
          autoComplete="off"
          enterKeyHint="send"
        />
        <button type="submit" className="caddie-composer__send" disabled={!canSend} aria-label="Send">
          <SendIcon size={18} />
        </button>
      </div>
      <VoiceButton voice={voice} />
    </form>
  );
}
