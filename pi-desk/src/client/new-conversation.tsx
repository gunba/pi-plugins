import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./connection.ts";
import { connectionLabel } from "./connection-state.ts";
import { FolderField } from "./folder-picker.tsx";
import { NewConversationModel, rememberModel, rememberedModel, type ModelChoice } from "./new-model.tsx";
import { Modal } from "./surfaces.tsx";
import type { Computer, WorkspaceSession, WorkspaceState } from "./workspace.ts";

/**
 * "New conversation": its dialog and state. `open` starts on a computer (by default the current conversation's, or
 * the first connected one) in a folder (by default the current conversation's on that computer, or the computer's).
 * Ctrl+T opens it too.
 */
export function useNewConversation({ host, session, current, created }: {
  host?: WorkspaceState; session?: WorkspaceSession; current?: Computer;
  /** The conversation was created: show it. */
  created: (key: string) => void;
}) {
  const [shown, setShown] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const createRequest = useRef(0);
  const [cwd, setCwd] = useState("");
  const [newComputer, setNewComputer] = useState<string>();
  const [newModel, setNewModel] = useState<ModelChoice>({ model: "", reasoning: "" });
  async function create(event: FormEvent) {
    event.preventDefault();
    if (creating) return;
    const request = ++createRequest.current;
    setCreating(true); setCreateError("");
    try {
      rememberModel(newComputer, newModel);
      const result = await api<{ key: string }>("/sessions", { cwd, ...(newModel.model ? { model: newModel.model } : {}),
        ...(newModel.reasoning ? { reasoning: newModel.reasoning } : {}) }, newComputer);
      if (request !== createRequest.current) return;
      setShown(false);
      created(result.key);
    } catch (error) {
      if (request === createRequest.current) setCreateError(error instanceof Error ? error.message : String(error));
    } finally { if (request === createRequest.current) setCreating(false); }
  }
  function open(computerId?: string, folder?: string) {
    const computer = computerId ? host?.computers?.find(computer => computer.id === computerId)
      : current?.connected ? current : host?.computers?.find(computer => computer.connected);
    createRequest.current++; setCreateError(""); setCreating(false);
    setNewComputer(computer?.id);
    setNewModel(rememberedModel(computer?.id));
    setCwd(folder ?? (session && session.computer === computer?.id ? session.cwd : computer?.cwd ?? host?.cwd ?? ""));
    setShown(true);
  }
  function close() { createRequest.current++; setShown(false); setCreating(false); }
  // Ctrl+T starts a new conversation. Chrome passes it to pages in app windows (--app); in a tab it keeps it for itself.
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    const pressed = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "t") { event.preventDefault(); latest.current(); }
    };
    window.addEventListener("keydown", pressed);
    return () => window.removeEventListener("keydown", pressed);
  }, []);
  const unavailable = !!host?.computers && !host.computers.some(computer => computer.id === newComputer && computer.connected);
  const dialog = shown && host && <Modal title="New conversation" close={close}>
    <form onSubmit={event => void create(event)}>
      {host.computers && <label>Computer
        <select aria-label="Computer for new conversation" disabled={creating} value={newComputer ?? ""} onChange={event => {
          setNewComputer(event.target.value);
          setNewModel(rememberedModel(event.target.value));
          setCwd(host.computers!.find(computer => computer.id === event.target.value)?.cwd ?? "");
        }}>
          {!newComputer && <option value="">Choose a connected computer</option>}
          {host.computers.map(computer => <option key={computer.id} value={computer.id} disabled={!computer.connected}>
            {computer.name}{computer.connected ? "" : ` · ${connectionLabel(computer)}`}
          </option>)}
        </select>
      </label>}
      <FolderField key={newComputer ?? "local"} value={cwd} onChange={setCwd} computer={newComputer} disabled={creating || unavailable} />
      <NewConversationModel sessions={host.sessions} computer={newComputer} value={newModel} change={setNewModel} disabled={creating} />
      <p className="muted">
        Pi loads this project's instructions, tools, and settings. Your model choice is remembered for next time.
      </p>
      {createError && <p className="error-text" role="alert">{createError}</p>}
      <div className="dialog-actions">
        <button type="button" onClick={close}>Cancel</button>
        <button className="primary" disabled={!cwd || creating || unavailable}>{creating ? "Creating…" : "Create conversation"}</button>
      </div>
    </form>
  </Modal>;
  return { open, dialog };
}
