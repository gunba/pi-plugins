import { join } from "node:path";
import { LocalQuestLog, QuestCalls, serveQuestCall, type QuestCall, type QuestLog, type QuestReply } from "../../../pi-agents/quest-log.ts";
import { QuestStore } from "../../../pi-agents/quests.ts";
import type { Quest, QuestActor, QuestView } from "../shared/quests.ts";
import type { Parties } from "./parties.ts";

interface QuestHost {
	closing(): boolean;
	/** The quest log's view changed; the app follows host state. */
	changed(): void;
	parties(): Parties | undefined;
	/** This computer's id in the account. */
	computer(): string | undefined;
}

/**
 * Jordan's quest log as the app shows it, and telling the agent that added a quest once it is finished. One computer
 * keeps the log for the account (pi-agents/quest-log.ts); the others send it their agents' and Dot connector's calls,
 * and the quests they kept before it did.
 */
export class HostQuests {
	store?: QuestStore;
	/** The log as the app shows it, while this computer keeps it. */
	view?: QuestView;
	private calls?: QuestCalls;
	private readonly host: QuestHost;
	constructor(host: QuestHost) { this.host = host; }

	open(agentDir: string): void {
		this.store = new QuestStore(join(agentDir, "party"));
		this.calls = new QuestCalls(join(agentDir, "party"));
	}
	/** The other computer that keeps the log, when one does. */
	server(): { id: string; name: string; online: boolean } | undefined { return this.calls?.server(); }
	/** This computer keeps the log: no other computer announces that it does. */
	keeps(): boolean { return !!this.store && !this.server(); }
	private local(): LocalQuestLog {
		return new LocalQuestLog(this.store!, (quest, by) => { if (quest) this.finished(quest, by); this.refresh(); });
	}
	/** The log for the app's and the Dot connector's changes, here or on the computer that keeps it. */
	log(): QuestLog { return this.calls!.remote() ?? this.local(); }

	/** Re-read the quest log when it, the date or working hours may have changed. */
	refresh(): void {
		if (this.host.closing() || !this.store) return;
		let next: QuestView | undefined;
		try { next = this.keeps() ? this.store.view() : undefined; }
		catch (error) { console.error(`The quest log could not be read: ${error instanceof Error ? error.message : String(error)}`); return; }
		if (JSON.stringify(next) === JSON.stringify(this.view)) return;
		this.view = next; this.host.changed();
	}

	/** Answer a call from another computer's agents or Dot connector, on the log this computer keeps. */
	serve(computer: string, call: unknown): Promise<QuestReply> {
		if (!this.keeps()) return Promise.resolve({ id: String((call as QuestCall)?.id), error: "This computer does not keep the quest log." });
		return serveQuestCall(this.local(), computer, this.host.computer() ?? "", call);
	}
	/** Take the quests another computer kept before this one kept the log; returns the ids taken. */
	take(computer: string, quests: unknown): string[] {
		if (!this.keeps() || !Array.isArray(quests) || quests.length > 50) throw Error("Invalid quests to take.");
		const ids = this.store!.take(quests, actor => actor.kind === "agent" && actor.id && !actor.id.includes("@") ? { ...actor, id: `${actor.id}@${computer}` } : actor);
		// That computer's Dot connector has seen them already.
		this.store!.changesSince(`dot@${computer}`, () => false);
		this.refresh();
		return ids;
	}
	/** Calls for the computer that keeps the log, marked sent. */
	outgoing(): QuestCall[] { return this.calls?.outgoing() ?? []; }
	settle(reply: unknown): void { this.calls?.settle(reply); }
	/** Quests this computer kept before another computer kept the log, a batch at a time, until they are taken. */
	leftover(): Quest[] { return this.store && this.server() ? this.store.batch() : []; }
	taken(ids: string[]): void { this.store?.remove(ids); }

	/**
	 * Tell the agent that added a quest that it is finished. An agent of another computer is told there, where its
	 * conversation gets the message even while closed and wakes for it.
	 */
	finished(quest: Quest, by: QuestActor): void {
		if (!this.store || quest.source.kind !== "agent" || !quest.source.id || !quest.notify || by.kind === "agent" && by.id === quest.source.id) return;
		if (quest.state !== "done" && quest.state !== "abandoned") return;
		const who = by.kind === "dot" ? "Jordan's Dot" : "Jordan";
		const text = `${who} ${quest.state === "done" ? "completed" : "abandoned"} the quest you added: “${quest.title}” (id ${quest.id}).${quest.state === "done" ? " Carry on with anything that was waiting on it." : ""}`;
		const [agent, computer] = quest.source.id.split("@");
		if (computer) this.store.queueNotice(computer, agent!, text);
		else this.deliver(agent!, text);
	}
	/** Message an agent on this computer from the host's quest-log identity. */
	deliver(agent: string, text: string): void {
		const parties = this.host.parties();
		if (!parties || !this.store) return;
		try {
			const service = this.store.service(), store = parties.store;
			if (store.member(service.session)?.owner !== service.owner) store.register(service.session, service.owner, "Quest log", "", "service");
			store.send(service.session, service.owner, agent, text, true);
		} catch (error) { console.error(`An agent could not be told about its quest: ${error instanceof Error ? error.message : String(error)}`); }
	}
	/** Notices for another computer's agents, until that computer takes them. */
	notices(computer: string): { id: number; agent: string; text: string }[] { return this.keeps() ? this.store!.notices(computer) : []; }
	noticesTaken(computer: string, ids: number[]): void { this.store?.dropNotices(computer, ids); }

	close(): void { this.store?.close(); this.calls?.close(); }
}
