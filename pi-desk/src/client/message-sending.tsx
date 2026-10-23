import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { SessionView, WorkerCommand } from "../shared/protocol.ts";
import type { InputStatus, PromptCommand } from "../shared/inputs.ts";
import { withDictationNote } from "../shared/dictation-note.ts";
import type { DraftFile, useAttachments } from "./attachments.tsx";
import { dictatedKey, draftKey, type Delivery } from "./composer-keys.ts";
import type { useConfirmation } from "./confirmation.tsx";
import { api, ApiError } from "./connection.ts";
import { deskCommand, type DeskCommandHandlers } from "./desk-commands.ts";
import { withDictation } from "./dictation.tsx";
import { admittedInput, clearSubmission, createSubmission, readSubmission, submissionDecision, submissionFingerprint, submissionKey, submitWithReceipt, type SubmissionReceipt } from "./input-submission.ts";

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function uploadedPrompt(text: string, files: DraftFile[], session: string): PromptCommand | undefined {
  if (files.some(file => file.uploaded?.session !== session)) return;
  return { kind: "prompt", text, ...(files.length ? { attachments: files.map(file => file.uploaded!.id) } : {}) };
}

/**
 * Sending the message box: a slash command runs here or in Pi; anything else is delivered to the conversation with a
 * receipt kept in this browser, so a message whose delivery was not confirmed is checked rather than sent twice,
 * including after a reload or reconnection.
 */
export function useMessageSending({ selected, selectedRef, session, connected, epoch, attachments, draft, setDraft, deliveryMode, controlBusy, extensionErrors,
  commandHandlers, command, confirmation, confirmationContext, show, delivered, report }: {
  selected: string; selectedRef: { readonly current: string }; session?: SessionView; connected: boolean; epoch: number;
  attachments: ReturnType<typeof useAttachments>; draft: string; setDraft: Dispatch<SetStateAction<string>>; deliveryMode: Delivery;
  controlBusy: boolean; extensionErrors: readonly unknown[]; commandHandlers: DeskCommandHandlers;
  command: <T = unknown>(command: WorkerCommand) => Promise<T>;
  confirmation: ReturnType<typeof useConfirmation>; confirmationContext: string;
  /** Shows a read-only command's output. */
  show: (title: string, text: string) => void;
  /** A message was delivered: the transcript follows it. */
  delivered: () => void;
  report: (error: string) => void;
}) {
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  useEffect(() => {
    if (!connected || !session?.activation || !attachments.ready || sendingRef.current) return;
    const receipt = JSON.parse(localStorage.getItem(submissionKey(selected)) ?? "null") as SubmissionReceipt | null;
    if (!receipt) return;
    let cancelled = false;
    const text = localStorage.getItem(draftKey(selected)) ?? "";
    const files = attachments.files;
    void (async () => {
      const status = await readSubmission(receipt, readInput);
      if (!admittedInput(status)) return;
      const prompt = uploadedPrompt(text, files, selected);
      const fingerprint = prompt ? await submissionFingerprint(prompt) : undefined;
      if (cancelled || sendingRef.current) return;
      if (fingerprint === receipt.fingerprint) await finishSubmission(receipt, text, files.map(file => file.id));
      else clearSubmission(localStorage, selected, receipt.id);
    })().catch(error => { if (!cancelled) report(errorText(error)); });
    return () => { cancelled = true; };
  }, [selected, connected, epoch, session?.activation, attachments.ready]);

  async function readInput(id: string): Promise<InputStatus> {
    return (await api<{ status: InputStatus }>(`/sessions/${selected}/inputs/${id}`)).status;
  }
  async function finishSubmission(receipt: SubmissionReceipt, text: string, fileIds: string[], shown = text) {
    if (JSON.parse(localStorage.getItem(submissionKey(selected)) ?? "null")?.id !== receipt.id) return;
    try { if (fileIds.length) await attachments.clear(fileIds); }
    catch { throw new Error("Message queued on the computer, but its attachment draft could not be cleared. The receipt is retained to prevent a duplicate."); }
    if (!clearSubmission(localStorage, selected, receipt.id)) return;
    if (localStorage.getItem(draftKey(selected)) === shown) { localStorage.removeItem(draftKey(selected)); localStorage.removeItem(dictatedKey(selected)); }
    if (selectedRef.current === selected) {
      setDraft(current => current === shown ? "" : current); delivered();
    }
  }
  /** Sends the draft; `dictated` text is sent with it without passing through the composer. */
  async function send(delivery: Delivery = deliveryMode, dictated?: string) {
    const shown = draft, text = dictated === undefined ? draft : withDictation(draft, dictated);
    // The agent is told the message was dictated, so it reads past misheard words.
    const modelText = text.trim() && (dictated !== undefined || localStorage.getItem(dictatedKey(selected)) === "1") ? withDictationNote(text) : text;
    // Dictated words that can't be sent now stay in the draft rather than being lost.
    const keep = () => {
      if (dictated === undefined || selectedRef.current !== selected) return;
      setDraft(current => current === shown ? text : current); localStorage.setItem(draftKey(selected), text); localStorage.setItem(dictatedKey(selected), "1");
    };
    if (!text.trim() && !attachments.files.length) return;
    if (!attachments.ready || sendingRef.current || controlBusy || !connected
      || extensionErrors.length || !session?.activation || !["starting", "ready"].includes(session.state)) { keep(); return; }
    if (delivery === "now" && !session.workerRuntime?.sendNow) {
      keep(); report("This worker does not support Send now. Restart this conversation when idle to enable it."); return;
    }
    const fileIds = attachments.files.map(file => file.id);
    sendingRef.current = true; setSending(true);
    try {
      const local = deskCommand(text, session.snapshot?.commands ?? [], commandHandlers);
      if (local) {
        if (fileIds.length) throw Error("Commands cannot include file attachments.");
        if (Object.hasOwn(commandHandlers, local.name)) await commandHandlers[local.name].execute(local.args);
        else {
          const info = session.snapshot?.commands.find(item => item.name === local.name);
          if (info?.execution === "read") {
            const value = await command<{ result: unknown }>({ kind: "native_read", name: local.name, args: local.args });
            if (selectedRef.current === selected) show(`/${local.name}`, typeof value.result === "string" ? value.result : JSON.stringify(value.result, null, 2) ?? "");
          } else if (info?.execution === "control") await command({ kind: "native", name: local.name, args: local.args });
          else throw Error(`/${local.name} has no Desk adapter.`);
        }
        if (localStorage.getItem(draftKey(selected)) === text) localStorage.removeItem(draftKey(selected));
        if (selectedRef.current === selected) setDraft(current => current === text ? "" : current);
        return;
      }
      const receiptKey = submissionKey(selected);
      let previous = JSON.parse(localStorage.getItem(receiptKey) ?? "null") as SubmissionReceipt | null;
      const status = previous ? await readSubmission(previous, readInput) : undefined;
      if (previous && admittedInput(status)) {
        // Check cached upload IDs before touching files that may already have been consumed.
        const cached = uploadedPrompt(modelText, attachments.files, session.key);
        if (cached && submissionDecision(previous, session.activation, await submissionFingerprint(cached), status) === "confirmed") {
          await finishSubmission(previous, text, fileIds, shown); return;
        }
        clearSubmission(localStorage, selected, previous.id);
        previous = null;
      }
      const uploaded = await attachments.upload(session.key, value => api(`/sessions/${selected}/uploads`, {
        activation: session.activation, command: value,
      }));
      const prompt: PromptCommand = {
        kind: "prompt", text: modelText, ...(uploaded.length ? { attachments: uploaded } : {}),
      };
      const fingerprint = await submissionFingerprint(prompt);
      const decision = submissionDecision(previous, session.activation, fingerprint, status);
      const reusable = decision === "reuse";
      if (decision === "confirm"
        && !await confirmation.request({
          title: "Send this message again?", context: confirmationContext, accept: "Send again", cancel: "Keep draft",
          body: <>
            <p>The earlier delivery was not confirmed. Check its history first.
              Sending now could duplicate a message that already arrived.</p>
            {text && <pre className="confirmation-preview">{text.slice(0, 2000)}{text.length > 2000 ? "…" : ""}</pre>}
            {!!fileIds.length && <p>{fileIds.length} attachment{fileIds.length === 1 ? "" : "s"}</p>}
          </>,
        })) return;
      const receipt = reusable ? previous! : createSubmission({
        activation: session.activation, state: session.state, generation: session.ui?.generation,
      }, fingerprint, delivery);
      localStorage.setItem(receiptKey, JSON.stringify(receipt));
      try {
        const input = await submitWithReceipt(receipt, async () => (await api<{ input: InputStatus }>(`/sessions/${selected}/inputs`, {
          id: receipt.id, activation: receipt.activation, generation: receipt.generation,
          command: { ...prompt, behavior: receipt.behavior },
        })).input, readInput);
        if (!admittedInput(input)) {
          localStorage.setItem(receiptKey, JSON.stringify({ ...receipt, requiresConfirmation: true }));
          throw new Error(input.error ?? "This message was cancelled. It was not sent again.");
        }
      }
      catch (error) {
        if (JSON.parse(localStorage.getItem(receiptKey) ?? "null")?.id === receipt.id) {
          if (error instanceof ApiError && error.status === 409) localStorage.setItem(receiptKey, JSON.stringify({ ...receipt, requiresConfirmation: true }));
        }
        throw error;
      }
      await finishSubmission(receipt, text, fileIds, shown);
    } catch (error) {
      keep();
      report(`${errorText(error)} Your draft has been kept.`);
    } finally {
      sendingRef.current = false; setSending(false);
    }
  }
  return { send, sending };
}
