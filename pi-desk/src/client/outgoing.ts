import type { ChatMessage, SessionView } from "../shared/protocol.ts";
import { admittedInput } from "./input-submission.ts";

/**
 * A message on its way to Pi, shown at the end of the conversation from the moment it is sent until the conversation
 * shows it, with its text or as one of the paragraphs of a message it was joined into. Pi may change a message (a
 * prompt template, an input handler), so arrival is also counted: after is the newest message in the conversation when
 * it was sent, queued how many messages Pi's queue held, and ahead how many sent earlier were still on their way.
 */
export interface Outgoing { id: string; session: string; message: ChatMessage; draft: string; after: number; queued: number; ahead: number; receipt?: string }
/** Messages sent into Pi's queue that are still waiting there, counted as sent though steering joins them into one. */
export const queuedCount = (session: SessionView | undefined) => {
  const queue = session?.snapshot?.queue;
  return (queue?.steering.sent ?? queue?.steering.count ?? 0) + (queue?.followUp.sent ?? queue?.followUp.count ?? 0);
};
export const newest = (messages: readonly ChatMessage[]) => messages.reduce((order, message) => Math.max(order, message.order), -Infinity);
/**
 * Whether the conversation now shows the message, or its pending-message card does: it failed or was cancelled, or it
 * waits for Pi to start, where the card offers to cancel it.
 */
export function arrived(item: Outgoing, session: SessionView | undefined, messages: readonly ChatMessage[]): boolean {
  const input = item.receipt ? session?.inputs?.find(input => input.id === item.receipt) : undefined;
  if (input && (!admittedInput(input) || input.state === "queued" && session?.state !== "ready")) return true;
  const users = messages.filter(message => message.role === "user" && !message.notice && message.order > item.after);
  // Steering sent while the agent works arrives joined into one message (native-queue-order.ts), which the count takes
  // for one, leaving all but the first of the messages joined, and every one sent after them, shown as on their way.
  const sent = textOf(item.message);
  if (sent && users.some(message => holds(textOf(message), sent))) return true;
  return users.length + Math.max(0, queuedCount(session) - item.queued) > item.ahead;
}

const textOf = (message: ChatMessage) => message.blocks.flatMap(block => block.type === "text" ? [block.full ?? block.text] : []).join("\n\n").trim();
/** Whether a message's text is the sent text, or holds it as one of the paragraphs steering joined. */
const holds = (text: string, sent: string) => text === sent || text.startsWith(sent + "\n\n") || text.endsWith("\n\n" + sent) || text.includes("\n\n" + sent + "\n\n");
