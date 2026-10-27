import { useEffect, useRef, useState, type FormEvent } from "react";
import { REACTIONS } from "../../shared/protocol";

export interface ChatMessage {
  key: string;
  name: string;
  text: string;
  self: boolean;
  system?: boolean;
}

interface ChatProps {
  messages: ChatMessage[];
  onSend(text: string): void;
  onReaction?(emoji: string): void;
  disabled?: boolean;
}

export function Chat({ messages, onSend, onReaction, disabled }: ChatProps) {
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function submit(event: FormEvent): void {
    event.preventDefault();
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value.slice(0, 500));
    setText("");
  }

  return (
    <div className="chat">
      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 && <div className="muted">Belum ada pesan. Sapa temanmu 👋</div>}
        {messages.map((m) => (
          <div key={m.key} className={`chat-msg${m.self ? " self" : ""}`}>
            {m.system ? (
              <span className="sys">{m.text}</span>
            ) : (
              <>
                <span className="who">{m.name}</span>
                <span>{m.text}</span>
              </>
            )}
          </div>
        ))}
      </div>
      {onReaction && (
        <div className="reaction-bar">
          {REACTIONS.map((emoji) => (
            <button key={emoji} type="button" title={`Kirim ${emoji}`} disabled={disabled} onClick={() => onReaction(emoji)}>
              {emoji}
            </button>
          ))}
        </div>
      )}
      <form className="chat-form" onSubmit={submit}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={disabled ? "Chat nonaktif" : "Ketik pesan..."}
          maxLength={500}
          disabled={disabled}
        />
        <button className="btn btn-primary btn-small" type="submit" disabled={disabled || !text.trim()}>
          Kirim
        </button>
      </form>
    </div>
  );
}
