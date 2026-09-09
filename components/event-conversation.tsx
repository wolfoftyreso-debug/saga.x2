import Link from "next/link";
import { ChatComposer } from "@/components/chat-composer";
import type { ConversationBlock, ConversationView } from "@/lib/services/workspace";

type EventConversationProps = {
  eventId: string;
  eventTitle: string;
  conversation: ConversationView | null;
};

/**
 * An event gets its own conversation boundary. This prevents event-specific
 * investigation from making the user's daily briefing thread noisy.
 */
export function EventConversation({ eventId, eventTitle, conversation }: EventConversationProps) {
  return (
    <section className="detail-section event-conversation" aria-labelledby="event-conversation-heading">
      <div className="event-conversation-heading">
        <div>
          <p className="eyebrow">EGEN HÄNDELSETRÅD</p>
          <h2 id="event-conversation-heading">Fortsätt resonemanget här</h2>
        </div>
        {conversation?.messages.length ? <span>{conversation.messages.length} meddelanden</span> : null}
      </div>
      <p className="event-conversation-intro">Frågor och uppföljningar om {eventTitle} stannar i den här tråden.</p>

      <div className="event-conversation-messages" aria-live="polite">
        {conversation?.messages.length ? conversation.messages.map((message) => {
          const eventWatchAction = Boolean(message.eventId) && ["watch_created", "watch_exists", "watch_update"].includes(message.action?.type ?? "");
          const actionHref = eventWatchAction ? `/events/${message.eventId}` : message.action?.href;
          return (
            <article className={`chat-message ${message.role === "user" ? "user" : "assistant"}`} key={message.id}>
              <p>{message.text}</p>
              {message.action && (
                <div className="chat-action-receipt">
                  <span className="eyebrow">{message.action.type === "watch_created" ? "BEVAKNING" : message.action.type === "direct_alert" ? "DIREKTNOTIS" : "UPPDATERING"}</span>
                  <strong>{message.action.title ?? "Inställning uppdaterad"}</strong>
                  {message.action.detail && <span>{message.action.detail}</span>}
                  {actionHref && <Link href={actionHref}>{eventWatchAction ? "Öppna händelsen →" : "Öppna →"}</Link>}
                </div>
              )}
              {message.role === "assistant" && <CitationLinks blocks={message.blocks} />}
            </article>
          );
        }) : (
          <div className="assistant-message quiet-message">
            <p>Ingen egen tråd ännu. Ställ en fråga så sparas den här, separat från din dagliga brief.</p>
          </div>
        )}
      </div>

      <ChatComposer
        conversationId={conversation?.id}
        eventId={eventId}
        presentation="inline"
        suggestions={[
          "Vad har faktiskt förändrats här?",
          "Vad kan detta betyda för mina verksamheter de närmaste 30 dagarna?",
          "Vad behöver jag bevaka innan jag agerar?",
          "Bevaka detta och säg till när status ändras, antas, träder i kraft eller upphävs.",
        ]}
      />
    </section>
  );
}

function CitationLinks({ blocks }: { blocks: ConversationBlock[] }) {
  const sources = blocks.flatMap((block) => {
    if (block.type !== "citations" || !Array.isArray(block.sources)) return [];
    return block.sources.flatMap((source) => {
      if (!source || typeof source !== "object" || Array.isArray(source)) return [];
      const value = source as { title?: unknown; url?: unknown };
      return typeof value.url === "string"
        ? [{ title: typeof value.title === "string" ? value.title : value.url, url: value.url }]
        : [];
    });
  });
  if (!sources.length) return null;
  return (
    <div className="chat-citations" aria-label="Källor för svaret">
      <span className="eyebrow">KÄLLOR ANVÄNDA I SVARET</span>
      {sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title} ↗</a>)}
    </div>
  );
}
