import { useEffect, useRef, useState } from 'react';
import type { CaddieMessage } from '@caddie/shared';

interface MessageListProps {
  messages: CaddieMessage[];
  busy: boolean;
  listening: boolean;
}

export function MessageList({ messages, busy, listening }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, busy]);

  return (
    <div className="messages" role="log" aria-live="polite">
      {messages.map((message) => (
        <p key={message.id} className={`bubble bubble--${message.role}`}>
          {message.text}
        </p>
      ))}

      {busy ? (
        <p className="bubble bubble--assistant bubble--typing" aria-label={listening ? 'Listening' : 'Thinking'}>
          <span />
          <span />
          <span />
        </p>
      ) : null}
      <div ref={endRef} />
    </div>
  );
}

interface ComposerProps {
  disabled: boolean;
  onSend: (text: string) => void;
}

export function Composer({ disabled, onSend }: ComposerProps) {
  const [value, setValue] = useState('');

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!value.trim()) return;
        onSend(value);
        setValue('');
      }}
    >
      <input
        type="text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Ask the Caddie..."
        aria-label="Message the Caddie"
        autoComplete="off"
        enterKeyHint="send"
      />
      <button type="submit" className="btn btn--primary" disabled={disabled || !value.trim()}>
        Send
      </button>
    </form>
  );
}
