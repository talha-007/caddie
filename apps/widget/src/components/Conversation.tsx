import { useEffect, useRef, useState } from 'react';
import type { CaddieMessage } from '@caddie/shared';

export function MessageList({ messages, busy }: { messages: CaddieMessage[]; busy: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, busy]);

  return (
    <div className="caddie-messages" role="log" aria-live="polite">
      {messages.map((message) => (
        <p key={message.id} className={`caddie-bubble caddie-bubble--${message.role}`}>
          {message.text}
        </p>
      ))}
      {busy ? (
        <p className="caddie-bubble caddie-bubble--assistant caddie-bubble--typing" aria-label="Caddie is thinking">
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
      className="caddie-composer"
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
      />
      <button type="submit" className="caddie-btn caddie-btn--primary" disabled={disabled || !value.trim()}>
        Send
      </button>
    </form>
  );
}
