"use client";

import { useRef, useState, useTransition, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";

const suggestions = [
  "Varför berör det mig?",
  "Vad ska jag göra?",
  "Lägg till en bevakning.",
];

type ChatComposerProps = {
  conversationId?: string;
  eventId?: string;
  presentation?: "fixed" | "inline";
  suggestions?: string[];
};

export function ChatComposer({
  conversationId,
  eventId,
  presentation = "fixed",
  suggestions: customSuggestions,
}: ChatComposerProps) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || isPending) return;
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: trimmed, conversationId: conversationId ?? null, eventId: eventId ?? null }),
        });
        const payload = await response.json() as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Meddelandet kunde inte skickas.");
        setMessage("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        router.refresh();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Meddelandet kunde inte skickas.");
      }
    });
  }

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setMessage(event.target.value);
    event.target.style.height = "auto";
    event.target.style.height = `${Math.min(event.target.scrollHeight, 168)}px`;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    formRef.current?.requestSubmit();
  }

  return (
    <section className={`chat-composer-wrap ${presentation === "inline" ? "inline" : ""}`} aria-label="Fråga Brief">
      <div className="chat-suggestions" aria-label="Förslag">
        {(customSuggestions ?? suggestions).map((suggestion) => (
          <button type="button" className="suggestion-chip" key={suggestion} onClick={() => setMessage(suggestion)}>{suggestion}</button>
        ))}
      </div>
      <form className="chat-composer" onSubmit={submit} ref={formRef}>
        <div className="chat-composer-input">
          <label className="sr-only" htmlFor="chat-message">Skriv vad du vill veta</label>
          <textarea
            id="chat-message"
            ref={textareaRef}
            value={message}
            rows={1}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="Skriv vad du vill veta"
            disabled={isPending}
            aria-describedby="chat-composer-help"
          />
          <p id="chat-composer-help">Enter skickar · Shift + Enter ger ny rad</p>
        </div>
        <button className="composer-send" type="submit" disabled={!message.trim() || isPending} aria-label={isPending ? "Skickar meddelande" : "Skicka meddelande"}>
          {isPending ? "…" : (
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M12 18V6M7 11l5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </form>
      {error && <p className="composer-error" role="alert">{error}</p>}
    </section>
  );
}
