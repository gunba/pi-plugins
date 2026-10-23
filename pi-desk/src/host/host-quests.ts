import { join } from "node:path";
import { QuestStore } from "../../../pi-agents/quests.ts";
import type { Quest, QuestActor, QuestView } from "../shared/quests.ts";
import type { Parties } from "./parties.ts";

interface QuestHost {
	closing(): boolean;
	/** The quest log's view changed; the app follows host state. */
	changed(): void;
	parties(): Parties | undefined;
}

/** Jordan's quest log on this computer as the app shows it, and telling the agent that added a quest once it is finished. */
export class HostQuests {
	store?: QuestStore;
	view?: QuestView;
	private readonly host: QuestHost;
	constructor(host: QuestHost) { this.host = host; }

	open(agentDir: string): QuestStore {
		this.store = new QuestStore(join(agentDir, "party"));
		return this.store;
	}

	/** Re-read the quest log when it, the date or working hours may have changed. */
	refresh(): void {
		if (this.host.closing() || !this.store) return;
		let next: QuestView;
		try { next = this.store.view(); } catch (error) { console.error(`The quest log could not be read: ${error instanceof Error ? error.message : String(error)}`); return; }
		if (JSON.stringify(next) === JSON.stringify(this.view)) return;
		this.view = next; this.host.changed();
	}

	/** Tell the agent that added a quest that it is finished, from the host's quest-log identity. */
	finished(quest: Quest, by: QuestActor): void {
		const parties = this.host.parties();
		if (!parties || !this.store || quest.source.kind !== "agent" || !quest.source.id || !quest.notify || by.kind === "agent" && by.id === quest.source.id) return;
		if (quest.state !== "done" && quest.state !== "abandoned") return;
		try {
			const service = this.store.service(), store = parties.store;
			if (store.member(service.session)?.owner !== service.owner) store.register(service.session, service.owner, "Quest log", "", "service");
			const who = by.kind === "dot" ? "Jordan's Dot" : "Jordan";
			store.send(service.session, service.owner, quest.source.id, `${who} ${quest.state === "done" ? "completed" : "abandoned"} the quest you added: “${quest.title}” (id ${quest.id}).${quest.state === "done" ? " Carry on with anything that was waiting on it." : ""}`, true);
		} catch (error) { console.error(`The agent that added “${quest.title}” could not be told: ${error instanceof Error ? error.message : String(error)}`); }
	}

	close(): void { this.store?.close(); }
}
