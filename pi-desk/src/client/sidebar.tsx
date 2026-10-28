import { useState } from "react";
import { api } from "./connection.ts";
import { activityLabel, backgroundWork, sessionActivity } from "./activity.ts";
import { useAppUpdate } from "./app-update.ts";
import { CloseConversationButton } from "./close-conversation.tsx";
import { connectionLabel, connectionTone, isOffline } from "./connection-state.ts";
import { VersionTag } from "./conversation-version.tsx";
import { DotNavigation, type DotConversationState } from "./dot-conversation.tsx";
import { Icon, ProviderIcon } from "./icons.tsx";
import type { MoveRequest } from "./move-conversation.tsx";
import { OsIcon } from "./os-icon.tsx";
import type { QuestLog } from "./quest-tracker.tsx";
import type { SessionView } from "../shared/protocol.ts";
import { unseen } from "../shared/attention.ts";
import { Navigation } from "./surfaces.tsx";
import { conversationTitle, folderName, type Computer, type WorkspaceState } from "./workspace.ts";

/** Renames a conversation in place in the sidebar: Enter saves, Escape or leaving the field cancels. */
/** Running conversations first, then sleeping ones (kept with a watch to wake them), then the rest that aren't running. */
const restRank = (item: SessionView) => item.state !== "closed" && item.state !== "failed" ? 0 : item.kept && (item.wakes || item.watching) ? 1 : 2;

function SidebarRename({ title, rename, close }: { title: string; rename: (name: string) => Promise<unknown>; close: () => void }) {
  const [draft, setDraft] = useState(title), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const save = async () => {
    if (saving) return;
    if (!draft.trim() || draft.trim() === title) { close(); return; }
    setSaving(true); setError("");
    try { await rename(draft.trim()); close(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); setSaving(false); }
  };
  return <form className="session-rename-form" onSubmit={event => { event.preventDefault(); void save(); }}>
    <input autoFocus aria-label="Conversation name" maxLength={300} value={draft} disabled={saving} onFocus={event => event.currentTarget.select()}
      onChange={event => setDraft(event.target.value)} onBlur={() => { if (!saving && !error) close(); }}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }} />
    {error && <small className="error-text" role="alert">{error}</small>}
  </form>;
}

/**
 * The conversation list: Dot and Tasks, then each computer's conversations, with copies of an off computer's
 * conversations to move elsewhere; a drawer on phones.
 */
export function Sidebar({ open, close, host, connected, transportConnected, selected, sending, dot, questLogs, select, newConversation, resume, openSettings, move, report, closed }: {
  open: boolean; close: () => void; host: WorkspaceState; connected: boolean;
  /** This browser's own connection, for a workspace without separate computers. */
  transportConnected: boolean;
  selected: string; sending: boolean; dot: DotConversationState; questLogs: QuestLog[];
  /** Shows a conversation, "dot" or "quests". */
  select: (key: string) => void;
  newConversation: (computer?: string) => void; resume: () => void; openSettings: (section: string) => void;
  move: (request: MoveRequest) => void; report: (error: string) => void;
  /** A conversation was closed from its row. */
  closed: (key: string) => void;
}) {
  const dotSelected = selected === "dot", questsSelected = selected === "quests", appUpdate = useAppUpdate();
  /** The conversation being renamed. */
  const [renaming, setRenaming] = useState("");
  /** An off computer's conversations that another computer keeps copies of, to move elsewhere. */
  const keptFor = (computer: { id?: string; connected?: boolean; loaded?: boolean; presence?: { online: boolean } }) => {
    // Only once it is known to be off: a computer reconnecting for a moment still has its own list.
    if (!computer.id || computer.loaded || computer.connected || !isOffline(computer)) return [];
    const seen = new Set<string>();
    return (host.computers ?? []).flatMap(holder => holder.teleport?.copies ?? [])
      .filter(copy => copy.computer === computer.id && !copy.moved && !seen.has(copy.session) && !!seen.add(copy.session))
      .sort((a, b) => Number(!!b.open) - Number(!!a.open) || b.updated - a.updated);
  };
  // Sections folded away, kept per browser; and off computers whose closed conversations are listed too.
  const [folded, setFolded] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem("pi-desk-folded-computers") ?? "[]")); } catch { return new Set(); } });
  const toggleFolded = (id: string) => setFolded(previous => {
    const next = new Set(previous); if (!next.delete(id)) next.add(id);
    localStorage.setItem("pi-desk-folded-computers", JSON.stringify([...next])); return next;
  });
  const [closedShown, setClosedShown] = useState<Set<string>>(() => new Set());
  const computers = host.computers ?? [{ id: undefined, name: host.name, platform: host.platform, connected, updates: host.updates, storageError: host.storageError,
    connection: connected ? "connected" as const : "reconnecting" as const, parties: host.parties, release: host.release }];
  const openQuests = questLogs.reduce((count, log) => count + log.view.quests.filter(quest => quest.state === "open").length + (log.view.upcoming?.length ?? 0), 0);
  return <Navigation open={open} close={close}>
    <div className="brand">
      <span className="brand-mark small">π</span>
      <strong>Pi Desk</strong>
    </div>
    <div className="sidebar-actions">
      <button className="new-chat" aria-label="New conversation" title="New conversation (Ctrl+T)" onClick={() => newConversation()}>
        <Icon name="plus" /> New chat
      </button>
      <button className="resume-chat" title="Resume conversation" aria-label="Resume conversation" onClick={resume}>
        <Icon name="clock" /> Resume
      </button>
    </div>
    <div className="sidebar-scroll">
    <div className="nav-label">Dots</div>
    <nav className="dot-list" aria-label="Dots">
      <DotNavigation dot={dot} selected={dotSelected} open={() => select("dot")} />
      <button className={`session-item quest-navigation${questsSelected ? " selected" : ""}`} aria-current={questsSelected ? "page" : undefined}
        onClick={() => select("quests")}>
        <span className="quest-navigation-icon" aria-hidden="true"><Icon name="plan" /></span>
        <span><strong>Tasks</strong><small>{openQuests ? `${openQuests} open` : "Workspace overview"}</small></span></button>
    </nav>
    <div className="nav-label">
      Computers <span>{computers.length}</span>
    </div>
    <nav className="session-list" aria-label="Computers">
      {computers.map(computer => <section key={computer.id ?? "local"} aria-label={computer.name}>
      <div className="computer-heading">
        <button type="button" className="computer-name" aria-expanded={!folded.has(computer.id ?? "local")}
          title={folded.has(computer.id ?? "local") ? `Show ${computer.name}'s conversations` : `Hide ${computer.name}'s conversations`}
          onClick={() => toggleFolded(computer.id ?? "local")}><OsIcon platform={computer.platform} /><strong>{computer.name}</strong>
          {folded.has(computer.id ?? "local") && host.sessions.some(item => item.computer === computer.id) &&
            <span className="computer-count">{host.sessions.filter(item => item.computer === computer.id).length}</span>}
          <Icon name="chevron" /></button>
        <small title={"latency" in computer && computer.latency !== undefined ? `Connected; round trip to ${computer.name} ${computer.direct ? "directly on this computer" : "through the relay"}: ${computer.latency} ms` : connectionLabel(computer)}>
          <span className={`status-dot ${connectionTone(computer)}`} role="img" aria-label={connectionLabel(computer)} />
          {/* The green dot says connected; words only when something is wrong, so the name has the room. */}
          {computer.connection !== "connected" && connectionLabel(computer)}</small>
        <button className="icon-button computer-create" aria-label={`New agent on ${computer.name}`} title={`New agent on ${computer.name}`}
          disabled={!computer.connected} onClick={() => newConversation(computer.id)}><Icon name="plus" /></button>
      </div>
      {!folded.has(computer.id ?? "local") && <>
      {computer.storageError && <details className="computer-storage-error"><summary><Icon name="warning" />Session save delayed</summary>
        <p>{computer.storageError}</p><button disabled={!computer.connected} onClick={() => void api("/storage/retry", {}, computer.id).catch(error => console.error("Catalog retry failed:", error))}>Retry saving</button>
      </details>}
      {(computer.updates?.available || computer.updates?.pending || computer.updates?.phase === "preparing") &&
        <button className="sidebar-update" onClick={() => openSettings("computers")}>
          {computer.updates.phase === "applying" ? "Applying update…" : computer.updates.phase === "preparing" ? "Preparing update…"
            : computer.updates.pending ? "Update ready" : "Update available"} →
        </button>}
      {computer.connection === "upgrade" && <div className="sidebar-hint upgrade-hint"><p>Update this computer and the app. Native conversations are retained.</p>
        <button onClick={() => location.reload()}>Reload app</button></div>}
      {host.sessions.filter(item => item.computer === computer.id)
        .sort((a, b) => restRank(a) - restRank(b) || Number(!!b.pinned) - Number(!!a.pinned) || b.created - a.created).map((item, index, rows) => {
        // A divider heads the conversations that aren't running.
        const resting = index === rows.findIndex(row => restRank(row) > 0) ? " first-resting" : "";
        const renamable = computer.connected && item.state === "ready" && !!item.ui;
        if (renaming === item.key && renamable) return <div className={`session-row${resting}`} key={item.key}>
          <SidebarRename title={conversationTitle(item)} close={() => setRenaming("")}
            rename={name => api(`/sessions/${item.key}/command`, { id: crypto.randomUUID(), generation: item.ui!.generation, command: { kind: "name", name } })} />
        </div>;
        const background = backgroundWork(item), activity = sessionActivity(item);
        // Finished since anyone looked: nothing will wake it, so it waits for the user (shared/attention.ts).
        const fresh = unseen(item) && !background && ["idle", "ready", "sleeping", "error"].includes(activity);
        const label = background?.label ?? (fresh && activity !== "error" ? "Finished" : activityLabel(activity));
        // A conversation that isn't running shows the model it resumes with.
        const model = item.snapshot?.model ?? item.lastModel, thinking = item.snapshot ? item.snapshot.thinking : item.lastModel?.thinking;
        // An idle conversation still waiting on something is not done: its dot and label say what it waits on.
        const dot = background && (activity === "idle" || activity === "ready") ? "background" : fresh && activity !== "error" ? "finished" : activity;
        return <div className={`session-row${resting}`} key={item.key}>
          <button className={`session-item ${selected === item.key ? "selected" : ""}${fresh ? " unseen" : ""}`} onClick={() => select(item.key)} onDoubleClick={() => { if (renamable) setRenaming(item.key); }}>
            <span className={`status-dot ${dot}`} role="img" aria-label={label} title={label} />
            <span><span className="session-label-line"><strong>{item.pinned ? "★ " : ""}{conversationTitle(item)}</strong></span>
              <small className="session-metadata"><span className="session-activity" title={background?.title}>
                {label}</span><span aria-hidden="true">·</span><span className="session-folder" title={item.cwd}>{folderName(item.cwd)}</span>
                <span className="session-marks"><VersionTag session={item} computer={computer} />
                {model && <span className="session-model" title={`${model.name}${thinking && thinking !== "off" ? ` · ${thinking} reasoning` : ""}${item.workerRuntime ? ` · Desk ${item.workerRuntime.version}` : ""}${item.snapshot ? "" : " · resumes with these"}`}>
                  <ProviderIcon id={model.provider} title={model.name} />
                  <span>{model.provider === "anthropic" ? model.name.replace(/^Claude\s+/i, "") : model.name}</span></span>}</span></small></span>
          </button>
          {renamable && <button type="button" className="icon-button session-rename" aria-label={`Rename ${conversationTitle(item)}`} title="Rename (or double-click the name)"
            onClick={() => setRenaming(item.key)}><Icon name="edit" /></button>}
          <CloseConversationButton icon session={item} name={conversationTitle(item)} computer={computer.name} connected={computer.connected}
             disabled={selected === item.key && sending} report={report}
            confirmed={() => closed(item.key)} />
        </div>;
      })}
      {computer.connection !== "upgrade" && !host.sessions.some(item => item.computer === computer.id) &&
        (keptFor(computer).length > 0 ? <>{keptFor(computer).filter(copy => copy.open || closedShown.has(computer.id!)).map(copy => <div className="session-row kept-copy" key={copy.session}>
          <span className="kept-copy-name" title={`${copy.cwd} · last active ${new Date(copy.updated).toLocaleString()}`}>
            <strong>{copy.title || folderName(copy.cwd)}</strong><small>{folderName(copy.cwd)} · {new Date(copy.updated).toLocaleDateString([], { day: "numeric", month: "short" })}</small></span>
          <button type="button" className="quiet-action" onClick={() => move({ source: computer as Computer, session: copy.session, title: copy.title || folderName(copy.cwd), cwd: copy.cwd })}>Move…</button>
        </div>)}
        {/* Only what was open there is listed; the rest of what is kept, on asking. */}
        {keptFor(computer).some(copy => !copy.open) && <button type="button" className="quiet-action kept-more"
          onClick={() => setClosedShown(previous => { const next = new Set(previous); if (!next.delete(computer.id!)) next.add(computer.id!); return next; })}>
          {closedShown.has(computer.id!) ? "Hide closed conversations" : `Closed conversations (${keptFor(computer).filter(copy => !copy.open).length})…`}</button>}</> :
        <p className="sidebar-hint">{"loaded" in computer && computer.loaded === false && computer.presence?.online !== false
          ? <span className="sidebar-loading"><span className="loading-spinner" aria-hidden="true" />Loading conversations…</span>
          : computer.connected ? "No open sessions." : "Connect to see open sessions."}</p>)}
      </>}
      </section>)}
    </nav>
    </div>
    <div className="sidebar-bottom">
      {appUpdate && <button className="sidebar-update" title="It loads by itself when this tab has been out of sight for a few minutes."
        onClick={() => location.reload()}><Icon name="refresh" /><span>New version of Desk: reload</span></button>}
      <button onClick={() => openSettings("general")}>
        <Icon name="settings" /><span>Settings</span>
      </button>
      <div className="host-label" title="Connections from this browser">
        <span
          className={`status-dot ${connectionTone({ connection: transportConnected ? "connected" : host.computers?.[0]?.connection ?? "connecting" })}`}
        />
        <span>{host.name}</span>
        <small>{host.computers ? `${host.computers.filter(computer => computer.connected).length}/${host.computers.length} connected` : connected ? "Connected" : "Reconnecting"}</small>
      </div>
    </div>
  </Navigation>;
}
