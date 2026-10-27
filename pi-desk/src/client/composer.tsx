import { useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ChatMessage, SessionView, ViewSnapshot, WorkerCommand } from "../shared/protocol.ts";
import { AttachmentList, type useAttachments } from "./attachments.tsx";
import type { useCommandCompletion } from "./command-completion.tsx";
import { composerKey, deliveryPreferenceKey, dictatedKey, draftKey, type Delivery } from "./composer-keys.ts";
import { ComposerResize } from "./composer-resize.tsx";
import { ComposerStatus } from "./composer-status.tsx";
import { DeliveryControl, deliveryModes } from "./delivery-control.tsx";
import { DictationButton, withDictation, type dictationComputer } from "./dictation.tsx";
import { Icon } from "./icons.tsx";
import { recallStep, sentMessages, type Recall } from "./message-history.ts";
import { ModelPicker } from "./model-picker.tsx";

/**
 * The message box: attachments, slash-command completion, Up and Down to recall earlier messages, the model and
 * reasoning controls, the conversation's status, dictation, Stop and Send.
 */
export function Composer({ session, selected, selectedRef, composerInput, recall, messages, draft, setDraft, attachments, completion, deliveryMode, setDeliveryMode,
  send, command, run, commandPromise, busy, controlBusy, settingBusy, connected, closing, sending, controls, extensionErrors, computer, dictation,
  accounts, history, openView, report }: {
  session: SessionView; selected: string; selectedRef: { readonly current: string };
  composerInput: RefObject<HTMLTextAreaElement | null>;
  /** The recall in progress, kept across conversations as the message box is. */
  recall: { current: Recall | undefined };
  messages: readonly ChatMessage[];
  draft: string; setDraft: Dispatch<SetStateAction<string>>;
  attachments: ReturnType<typeof useAttachments>; completion: ReturnType<typeof useCommandCompletion>;
  deliveryMode: Delivery; setDeliveryMode: (value: Delivery) => void;
  send: (delivery?: Delivery, dictated?: string) => Promise<void>;
  command: <T = unknown>(command: WorkerCommand) => Promise<T>;
  run: (command: WorkerCommand) => void; commandPromise: (command: WorkerCommand) => Promise<void>;
  busy: boolean; controlBusy: boolean; settingBusy: boolean; connected: boolean; closing: boolean; sending: boolean;
  controls: NonNullable<SessionView["controls"]>; extensionErrors: readonly unknown[];
  /** The conversation's computer, by name. */
  computer: string;
  dictation: ReturnType<typeof dictationComputer>;
  accounts: (provider: string) => void; history: () => void; openView: (view: ViewSnapshot) => void;
  report: (error: string) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  // Up and Down in the message box bring back your earlier messages, as in a terminal (message-history.ts).
  const sent = useMemo(() => sentMessages(messages), [messages]);
  const selectedModel = session?.snapshot?.model;
  const isDefaultModel = !!selectedModel && selectedModel.provider === session?.snapshot?.defaultModel?.provider
    && selectedModel.id === session.snapshot.defaultModel.id;
  const modelPreferences = session.snapshot && <>
    <button type="button" className={`icon-button model-default${isDefaultModel ? " is-default" : ""}`}
      aria-label={isDefaultModel ? "Default model on this computer" : "Set selected model as default"}
      title={isDefaultModel ? "Default for new conversations on this computer" : "Set as default for new conversations on this computer"}
      disabled={isDefaultModel || settingBusy || !connected || session.state !== "ready" || !selectedModel}
      onClick={() => selectedModel && run({ kind: "model", provider: selectedModel.provider, id: selectedModel.id, makeDefault: true })}>
      <Icon name="star" />
    </button>
    <select
      aria-label="Reasoning level"
      title="Change reasoning; active work stops and continues with the new setting"
      value={session.snapshot?.thinking ?? ""}
      disabled={settingBusy || !connected || session.state !== "ready"}
      onChange={(event) =>
        run({ kind: "thinking", level: event.target.value })
      }
    >
      {session.snapshot?.thinkingLevels.map((level) => (
        <option key={level} value={level}>
          {level.charAt(0).toUpperCase() + level.slice(1)}
        </option>
      ))}
    </select>
  </>;
  return <form className={`composer${draggingFiles ? " file-drop" : ""}`} onSubmit={event => { event.preventDefault(); void send(); }}
    onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDraggingFiles(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false); }}
    onDrop={event => {
      event.preventDefault(); setDraggingFiles(false);
      if (!sending && attachments.ready) attachments.add(event.dataTransfer.files);
    }}>
    <ComposerResize input={composerInput} />
    <AttachmentList files={attachments.files} disabled={sending} remove={attachments.remove} />
    <input ref={fileInput} type="file" multiple hidden aria-label="Choose attachments" disabled={sending || !attachments.ready}
      onChange={event => { if (event.target.files) attachments.add(event.target.files); event.target.value = ""; }} />
    {completion.menu}
    <textarea
      ref={composerInput} aria-label="Message Pi"
      aria-autocomplete="list"
      aria-controls={completion.active ? "command-completion" : undefined}
      aria-activedescendant={completion.selected}
      disabled={sending}
      placeholder={
        busy
          ? "Steer Pi, or queue a follow-up…"
          : "Ask Pi anything about your project…"
      }
      value={draft}
      rows={3}
      onPaste={event => {
        if (event.clipboardData.files.length) { event.preventDefault(); attachments.add(event.clipboardData.files); }
      }}
      onChange={(event) => {
        setDraft(event.target.value);
        localStorage.setItem(draftKey(selected), event.target.value);
        if (!event.target.value.trim()) localStorage.removeItem(dictatedKey(selected));
      }}
      onKeyDown={(event) => {
        if (completion.keyDown(event)) return;
        if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.nativeEvent.isComposing) {
          const editor = event.currentTarget;
          // A new recall asks the conversation for your messages: after a long turn, none may be loaded here.
          if (event.key === "ArrowUp" && draft === "" && !(recall.current && recall.current.shown === draft)) {
            event.preventDefault();
            const conversation = selected;
            void (async () => {
              let list: readonly string[] = sent;
              try {
                const reply = await command<{ result?: string[] | null }>({ kind: "sent_messages" });
                if (Array.isArray(reply?.result) && reply.result.length) list = reply.result;
              } catch { /* A conversation on an older Desk: the messages loaded here. */ }
              const step = recallStep("ArrowUp", "", { start: 0, end: 0 }, list);
              if (!step || "done" in step || selectedRef.current !== conversation || composerInput.current?.value !== "") return;
              recall.current = step; setDraft(step.shown); localStorage.setItem(draftKey(conversation), step.shown);
              requestAnimationFrame(() => editor.setSelectionRange(step.shown.length, step.shown.length));
            })();
            return;
          }
          const step = recallStep(event.key, draft, { start: editor.selectionStart, end: editor.selectionEnd }, sent, recall.current);
          if (step) {
            event.preventDefault();
            const text = "done" in step ? step.done : step.shown;
            recall.current = "done" in step ? undefined : step;
            setDraft(text); localStorage.setItem(draftKey(selected), text);
            requestAnimationFrame(() => editor.setSelectionRange(text.length, text.length));
            return;
          }
        }
        const action = composerKey({ key: event.key, altKey: event.altKey, ctrlKey: event.ctrlKey,
          metaKey: event.metaKey, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing },
          matchMedia("(pointer:fine)").matches, deliveryMode);
        if (!action) return;
        event.preventDefault();
        if (action === "newline") {
          const editor = event.currentTarget, start = editor.selectionStart;
          const text = `${draft.slice(0, start)}\n${draft.slice(editor.selectionEnd)}`;
          setDraft(text); localStorage.setItem(draftKey(selected), text);
          requestAnimationFrame(() => editor.setSelectionRange(start + 1, start + 1));
        } else {
          void send(action);
        }
      }}
    />
    <div className="composer-controls">
      <div className="model-controls">
        {session.snapshot && <>
        <ModelPicker snapshot={session.snapshot} disabled={settingBusy || !connected || session.state !== "ready"}
          select={(model, context) => run({ kind: "model", provider: model.provider, id: model.id, ...(context ? { context } : {}) })}
          accounts={accounts} history={history} refresh={() => void command({ kind: "models" }).catch(() => {})} />
        <div className="composer-preferences">{modelPreferences}</div>
        </>}
      </div>
      <ComposerStatus key={session.key} session={session} computer={computer} connected={connected} disabled={closing}
        preferences={modelPreferences} shortcutHint={`Enter: ${deliveryModes.find(mode => mode.value === deliveryMode)!.label} · Shift+Enter: new line · Ctrl+Enter: send now · Alt+Enter: queue`}
        open={openView}
        invoke={(view, action, value) => commandPromise({ kind: "action", view: view.id, revision: view.revision, action: action.id, value })} />
      <div className="send-controls">
        <DictationButton disabled={!connected} report={report} submit={text => void send(deliveryMode, text)} computer={dictation} append={text => setDraft(current => {
          const next = withDictation(current, text); localStorage.setItem(draftKey(selected), next); localStorage.setItem(dictatedKey(selected), "1"); return next;
        })} />
        <button type="button" className="icon-button" aria-label="Attach files" title="Attach files (up to 8 MiB each)"
          disabled={sending || !attachments.ready} onClick={() => fileInput.current?.click()}>＋</button>
        {busy && controls.every(control => control.state !== "running" || ["compact", "navigate"].includes(control.kind)) && (
          <button
            className="stop-button"
            type="button"
            aria-label="Stop Pi"
            disabled={!connected}
            onClick={() => run({ kind: "abort" })}
          >
            ■
          </button>
        )}
        <DeliveryControl value={deliveryMode} scope={selected} busy={busy && !controlBusy}
          canSendNow={!!session.workerRuntime?.sendNow} send={value => void send(value)}
          choose={value => { setDeliveryMode(value); localStorage.setItem(deliveryPreferenceKey, value); composerInput.current?.focus({ preventScroll: true }); }}
          disabled={(!draft.trim() && !attachments.files.length) || !attachments.ready || !!extensionErrors.length
            || sending || controlBusy || !connected || !session.activation || !["starting", "ready"].includes(session.state)} />
      </div>
    </div>
    {attachments.progress && <p className="upload-progress" role="status">Uploading {attachments.progress}</p>}
    {!!attachments.files.length && session.snapshot?.model && !session.snapshot.model.images && (
      <p className="upload-progress">This model receives attachments as file paths. Image input is not supported by this model.</p>
    )}
  </form>;
}
