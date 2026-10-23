import type { UiDetails } from "../../../pi-ui/index.ts";
import type { ChatMessage, HistoryPage, ViewSnapshot, WorkerCommand } from "../shared/protocol.ts";
import { Configuration } from "./configuration.tsx";
import { DetailsView } from "./details-view.tsx";
import { MessageView as Message } from "./message-view.tsx";
import { PlanView } from "./plan-view.tsx";
import { transcriptKey } from "./state.ts";
import { TranscriptView } from "./transcript-view.tsx";
import { WorkspaceActions } from "./workspace-actions.tsx";

const emptyMessages: ChatMessage[] = [];

/** One of a conversation's views, such as the plan, Messages or an extension's settings, as a card in the view panel. */
export function ViewCard({ view, session, generation, connected, closing, epoch, messages, onLatest, run, openAgents }: {
  view: ViewSnapshot; session: string; generation: string; connected: boolean; closing: boolean; epoch: number;
  /** Loaded transcripts, by transcript key, for a view that shows one. */
  messages: Record<string, ChatMessage[] | undefined>;
  onLatest: (source: string | undefined, page: HistoryPage) => void;
  run: (command: WorkerCommand) => void; openAgents: () => void;
}) {
  return <section className="panel-card" data-view={view.id}>
    {view.kind === "configuration" ? <Configuration key={`${session}:${generation}:${view.id}`} view={view} disabled={!!view.working || !connected || closing}
      invoke={(action, value) => run({ kind: "action", view: view.id, revision: view.revision, action: action.id, value })} />
    : view.id === "plan" && view.kind === "details" ? <PlanView view={view} showHeading={false} disabled={!connected || closing}
      invoke={action => run({ kind: "action", view: view.id, revision: view.revision, action: action.id })} /> : <>
    <div className="panel-section-heading">
    <WorkspaceActions view={view} disabled={!!view.working || !connected}
      invoke={action => run({ kind: "action", view: view.id, revision: view.revision, action: action.id })} />
    </div>
    {view.working && <p className="muted" role="status">{view.working}…</p>}
    {view.actionError && <p className="error-text" role="alert">{view.actionError}</p>}
    {view.kind === "details" ? <>
      <DetailsView data={view.id === "subagents" ? { ...view.data as UiDetails, items: [] } : view.data as UiDetails}
        disabled={!!view.working || !connected} invoke={(action, value) => run({
          kind: "action", view: view.id, revision: view.revision, action: action.id, value,
        })} />
      {view.id === "subagents" && <button onClick={openAgents}>Browse agents and history →</button>}
      {(view.data as UiDetails).transcript && <TranscriptView key={(view.data as UiDetails).transcript}
        source={(view.data as UiDetails).transcript!} session={session} generation={generation}
        connected={connected} epoch={epoch}
        messages={messages[transcriptKey(session, (view.data as UiDetails).transcript!)] ?? emptyMessages}
        onLatest={onLatest} renderMessage={(message, results, thinking, traceContinues) => <Message message={message} results={results} thinking={thinking} traceContinues={traceContinues} sessionKey={session} source={(view.data as UiDetails).transcript} />} />}
    </> : (
      <pre>
        {typeof view.data === "string"
          ? view.data
          : JSON.stringify(view.data, null, 2)}
      </pre>
    )}
    </>}
  </section>;
}
