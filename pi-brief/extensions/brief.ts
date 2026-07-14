import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
	getMarkdownTheme,
	keyHint,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type BriefDocument,
	type BriefSessionState,
	type BriefSnapshot,
	compileBriefPrompt,
	snapshotFromState,
	validateBrief,
} from "../model.ts";

const STATE_ENTRY = "pi-brief-state";
const TOOL_NAME = "present_brief";
const INTERNAL_APPROVE_ARGUMENT = "__approve-current-brief";
const STATUS_KEY = "pi-brief";
const WIDGET_KEY = "pi-brief-guidance";

const BRIEF_MODE_PROMPT = `

# Brief authoring mode

You are now a brief author, not the executor of the requested task. Convert weak user intent into a precise, self-contained prompt for a fresh conversation.

Non-negotiable behaviour:
- Do not solve the task, make implementation changes, or produce an implementation plan disguised as a brief. You may inspect the project and use research tools when that materially improves the brief.
- On the first turn, use the present_brief tool to render a complete best-judgement draft. Do not postpone the draft until every uncertainty is answered; record material uncertainty under openQuestions.
- The present_brief tool writes the current compiled brief to a project-local draft file. Treat that file as the editable working copy; if the user says they changed it, read it before producing the next revision.
- After each user feedback turn, update every affected section and call present_brief again with the complete revised brief.
- Ask the clarifying questions needed to remove material ambiguity. Batch or sequence them according to the task and the user's feedback; do not impose an arbitrary question count. The user may answer, edit any section, or defer a decision back to the executing agent.
- A required process belongs in every brief. If the user does not prescribe one, design a suitable process and make its decision and escalation points explicit.
- A concrete time horizon belongs in every brief. Specify expected duration, a meaningful minimum effort or search horizon, persistence rules that prevent arbitrary early exit, and a return policy. Difficult autonomous tasks may require a minimum elapsed time as well as iteration or coverage thresholds.
- Unless the user explicitly permits partial delivery, the partial-work policy must prohibit returning partial work, nearby substitutes, reductions, or best-effort summaries as if they completed the task.
- Enumerate likely near-misses, edge cases, and ways an executor could technically comply while violating the user's real intent.
- Treat verification as an adversarial acceptance workflow, not a generic request to double-check.
- Preserve solution latitude: specify outcomes, boundaries, process, evidence, and stopping rules without inventing repository files or prematurely selecting an implementation.
- Use action="approve" only after explicit user approval. Include the user's approval words in approvalEvidence. Never infer approval from silence or merely positive feedback.
- When approval is explicit, call present_brief with the final full brief and action="approve". The extension will replace the current conversation and send the compiled brief there.

The brief must be signal-dense. Every statement should define, constrain, prioritize, prescribe process, govern uncertainty, verify, or establish a stopping condition.`;

const stringArray = (description: string) =>
	Type.Array(Type.String(), { description });

const briefSchema = Type.Object({
	title: Type.String({ description: "Short descriptive title for the task." }),
	mission: Type.String({
		description:
			"The exact outcome to accomplish, without prescribing an implementation.",
	}),
	motivation: Type.String({
		description: "Why the task matters and what prompted it.",
	}),
	userVisibleOutcome: Type.String({
		description:
			"What becomes possible, different, or true for the relevant user.",
	}),
	definitions: stringArray(
		"Terms whose meaning must be fixed to prevent divergence.",
	),
	scope: Type.Object({
		included: stringArray(
			"Cases, actors, environments, and boundaries included in the task.",
		),
		excluded: stringArray("Cases and scope explicitly outside the task."),
		assumptions: stringArray("Assumptions the executor may rely upon."),
	}),
	requirements: Type.Object({
		must: stringArray("Requirements necessary for success."),
		should: stringArray(
			"Important preferences that may yield to an explicit trade-off.",
		),
		may: stringArray("Permitted latitude and optional behaviour."),
		mustNot: stringArray("Prohibited outcomes, methods, and regressions."),
	}),
	acceptanceCriteria: stringArray(
		"Observable evidence that demonstrates completion.",
	),
	nonGoals: stringArray(
		"Near-misses, partial substitutes, shortcuts, and scope expansions that do not count.",
	),
	edgeCases: stringArray(
		"Valid unusual cases and likely reasoning or execution failure modes.",
	),
	constraintsAndTradeoffs: stringArray(
		"Compatibility, scale, security, privacy, maintainability, budget, and priority rules.",
	),
	openQuestions: stringArray(
		"Material decisions not yet resolved; leave empty when none remain.",
	),
	process: stringArray(
		"Required execution process, including stages, decision points, review, and escalation.",
	),
	timeHorizon: Type.Object({
		expectedDuration: Type.String({
			description: "Expected wall-clock or work duration, stated concretely.",
		}),
		minimumEffort: Type.String({
			description:
				"Minimum elapsed time, rounds, coverage, or evidence required before returning.",
		}),
		persistenceRules: stringArray(
			"Rules preventing arbitrary early exit and governing retries or alternate approaches.",
		),
		returnPolicy: Type.String({
			description: "When the executor may return and what must be true first.",
		}),
	}),
	verification: stringArray(
		"Required checks, evidence, audits, and named failure modes to challenge.",
	),
	deliverables: stringArray(
		"Artifacts and supporting evidence the fresh conversation must return.",
	),
	interactionRules: stringArray(
		"When the executor must ask, may assume, should escalate, or must defer to the user.",
	),
	completion: Type.Object({
		successConditions: stringArray(
			"Conditions that jointly define complete success.",
		),
		stopConditions: stringArray(
			"The only conditions under which work may legitimately stop.",
		),
		blockerPolicy: Type.String({
			description:
				"How unforeseen impossibility or conflicting requirements must be handled.",
		}),
		partialWorkPolicy: Type.String({
			description:
				"Explicit policy for partial work; prohibit it unless the user allowed it.",
		}),
	}),
	sourcesAndTools: stringArray(
		"Permitted or required sources, tools, authority hierarchy, and privacy boundaries.",
	),
});

const toolParameters = Type.Object({
	action: StringEnum(["draft", "approve"] as const, {
		description:
			"Render a draft/update, or approve only after explicit user approval.",
	}),
	approvalEvidence: Type.Optional(
		Type.String({
			description:
				"Required for approve: the user's explicit approval words from the conversation.",
		}),
	),
	brief: briefSchema,
});

function nonEmpty(values: string[]): string[] {
	return values.map((value) => value.trim()).filter(Boolean);
}

function markdownList(values: string[], empty = "*None specified.*"): string {
	const items = nonEmpty(values);
	return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : empty;
}

function expandedBriefMarkdown(snapshot: BriefSnapshot): string {
	const { brief } = snapshot;
	return [
		snapshot.filePath ? `**Draft file:** \`${snapshot.filePath}\`` : "",
		`## Mission\n\n${brief.mission}`,
		`## Context and motivation\n\n${brief.motivation}`,
		`## User-visible outcome\n\n${brief.userVisibleOutcome}`,
		`## Definitions\n\n${markdownList(brief.definitions)}`,
		`## Scope\n\n### Included\n${markdownList(brief.scope.included)}\n\n### Excluded\n${markdownList(brief.scope.excluded)}\n\n### Assumptions\n${markdownList(brief.scope.assumptions)}`,
		`## Requirements\n\n### Must\n${markdownList(brief.requirements.must)}\n\n### Should\n${markdownList(brief.requirements.should)}\n\n### May\n${markdownList(brief.requirements.may)}\n\n### Must not\n${markdownList(brief.requirements.mustNot)}`,
		`## Acceptance criteria\n\n${markdownList(brief.acceptanceCriteria)}`,
		`## Non-goals and near-miss exclusions\n\n${markdownList(brief.nonGoals)}`,
		`## Edge cases and failure modes\n\n${markdownList(brief.edgeCases)}`,
		`## Constraints and trade-offs\n\n${markdownList(brief.constraintsAndTradeoffs)}`,
		`## Required process\n\n${markdownList(brief.process)}`,
		`## Time horizon and persistence\n\n**Expected duration:** ${brief.timeHorizon.expectedDuration}\n\n**Minimum effort:** ${brief.timeHorizon.minimumEffort}\n\n### Persistence rules\n${markdownList(brief.timeHorizon.persistenceRules)}\n\n**Return policy:** ${brief.timeHorizon.returnPolicy}`,
		`## Verification and adversarial audit\n\n${markdownList(brief.verification)}`,
		`## Deliverables\n\n${markdownList(brief.deliverables)}`,
		`## Interaction and escalation\n\n${markdownList(brief.interactionRules)}`,
		`## Completion and stopping\n\n### Success conditions\n${markdownList(brief.completion.successConditions)}\n\n### Permitted stopping conditions\n${markdownList(brief.completion.stopConditions)}\n\n**Blocker policy:** ${brief.completion.blockerPolicy}\n\n**Partial-work policy:** ${brief.completion.partialWorkPolicy}`,
		`## Sources and tools\n\n${markdownList(brief.sourcesAndTools)}`,
		`## Open questions\n\n${markdownList(brief.openQuestions, "*No unresolved questions.*")}`,
	].join("\n\n");
}

function compactBriefMarkdown(snapshot: BriefSnapshot): string {
	const { brief } = snapshot;
	const counts = [
		`${brief.process.length} process steps`,
		`${brief.acceptanceCriteria.length} acceptance checks`,
		`${brief.verification.length} audit checks`,
		`${brief.edgeCases.length} edge cases`,
	].join(" · ");
	const openQuestions = nonEmpty(brief.openQuestions);

	return [
		`**Mission**  \n${brief.mission}`,
		`**Outcome**  \n${brief.userVisibleOutcome}`,
		snapshot.filePath ? `**Draft file**  \n\`${snapshot.filePath}\`` : "",
		`**Time horizon**  \n${brief.timeHorizon.expectedDuration} — minimum: ${brief.timeHorizon.minimumEffort}`,
		`**Coverage**  \n${counts}`,
		openQuestions.length > 0
			? `**Open questions (${openQuestions.length})**\n${markdownList(openQuestions.slice(0, 3))}`
			: "**Open questions**  \nNone — ready for approval.",
	].join("\n\n");
}

function expansionHint(): string {
	try {
		return keyHint("app.tools.expand", "expand full brief");
	} catch {
		return "ctrl+o expand full brief";
	}
}

function createBriefCard(
	snapshot: BriefSnapshot,
	expanded: boolean,
	theme: Theme,
): Box {
	const approved = snapshot.status === "approved";
	const statusColor = approved ? "success" : "warning";
	const statusLabel = approved ? "APPROVED" : "DRAFT";
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	const heading = [
		theme.fg(statusColor, theme.bold(`◆ ${statusLabel}`)),
		theme.fg("accent", theme.bold(snapshot.brief.title)),
		theme.fg("dim", `revision ${snapshot.revision}`),
	].join("  ");
	box.addChild(new Text(heading, 0, 0));
	box.addChild(new Spacer(1));
	box.addChild(
		new Markdown(
			expanded
				? expandedBriefMarkdown(snapshot)
				: compactBriefMarkdown(snapshot),
			0,
			0,
			getMarkdownTheme(),
		),
	);
	box.addChild(new Spacer(1));
	const footer = approved
		? "Replacing this conversation with the approved brief…"
		: `Reply with changes or approve naturally · ${expansionHint()}`;
	box.addChild(new Text(theme.fg("dim", footer), 0, 0));
	return box;
}

function latestPersistedState(
	ctx: ExtensionContext,
): BriefSessionState | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type === "custom" && entry.customType === STATE_ENTRY) {
			return entry.data as BriefSessionState | undefined;
		}
	}
	return undefined;
}

function emptyState(): BriefSessionState {
	return { active: false, revision: 0, status: "draft" };
}

function filenameSegment(title: string): string {
	let result = "";
	let pendingSeparator = false;
	for (const character of title.normalize("NFKD").toLowerCase()) {
		const code = character.charCodeAt(0);
		const isAsciiLetter = code >= 97 && code <= 122;
		const isDigit = code >= 48 && code <= 57;
		if (isAsciiLetter || isDigit) {
			if (pendingSeparator && result) result += "-";
			result += character;
			pendingSeparator = false;
		} else if (result) {
			pendingSeparator = true;
		}
		if (result.length >= 48) break;
	}
	return result || "brief";
}

function createDraftPath(cwd: string, title: string): string {
	const timestamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
	return join(
		cwd,
		CONFIG_DIR_NAME,
		"briefs",
		`${timestamp}-${filenameSegment(title)}.md`,
	);
}

async function writeDraftFile(
	path: string,
	brief: BriefDocument,
): Promise<void> {
	await withFileMutationQueue(path, async () => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, compileBriefPrompt(brief), "utf8");
	});
}

function renderBriefModeUi(
	ctx: ExtensionContext,
	state: BriefSessionState,
): void {
	if (!state.active) {
		clearBriefModeUi(ctx);
		return;
	}

	const revision = state.revision > 0 ? ` v${state.revision}` : "";
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `◆ brief${revision}`));
	ctx.ui.setWidget(
		WIDGET_KEY,
		(_tui, theme) =>
			new Text(
				`${theme.fg("accent", theme.bold("Brief authoring"))} ${theme.fg("dim", "· research as needed · reply with feedback or approval")}`,
				0,
				0,
			),
		{ placement: "belowEditor" },
	);
}

function clearBriefModeUi(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}

class BriefPresenter {
	private readonly pi: ExtensionAPI;
	private readonly getState: () => BriefSessionState;
	private readonly persistState: () => void;
	private readonly updateUi: (ctx: ExtensionContext) => void;

	constructor(
		pi: ExtensionAPI,
		getState: () => BriefSessionState,
		persistState: () => void,
		updateUi: (ctx: ExtensionContext) => void,
	) {
		this.pi = pi;
		this.getState = getState;
		this.persistState = persistState;
		this.updateUi = updateUi;
		this.register();
	}

	private register(): void {
		const presenter = this;
		this.pi.registerTool({
			name: TOOL_NAME,
			label: "Task Brief",
			description:
				"Render the complete current task brief. Use draft for every revision and approve only after explicit user approval.",
			parameters: toolParameters,
			executionMode: "sequential",
			renderShell: "self",
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const state = presenter.getState();
				if (!state.active || !state.task) {
					throw new Error("No active brief. Start one with /brief <task>.");
				}

				const brief = params.brief as BriefDocument;
				const errors = validateBrief(brief);
				if (errors.length > 0) {
					throw new Error(`Brief is incomplete:\n- ${errors.join("\n- ")}`);
				}

				if (params.action === "approve" && !params.approvalEvidence?.trim()) {
					throw new Error(
						"Approval requires approvalEvidence containing the user's explicit approval words.",
					);
				}

				state.draft = structuredClone(brief);
				state.revision += 1;
				state.status = params.action === "approve" ? "approved" : "draft";
				state.filePath ??= createDraftPath(ctx.cwd, brief.title);
				await writeDraftFile(state.filePath, brief);
				presenter.persistState();
				presenter.updateUi(ctx);

				const snapshot = snapshotFromState(state);
				if (!snapshot) throw new Error("Failed to create the brief snapshot.");

				if (params.action === "approve") {
					presenter.pi.sendUserMessage(`/brief ${INTERNAL_APPROVE_ARGUMENT}`, {
						deliverAs: "followUp",
					});
				}

				return {
					content: [
						{
							type: "text",
							text:
								params.action === "approve"
									? `Approved brief revision ${state.revision}; conversation replacement is queued. Draft: ${state.filePath}`
									: `Rendered brief revision ${state.revision} and wrote ${state.filePath}. Continue refining it from user feedback; do not execute the task.`,
						},
					],
					details: snapshot,
				};
			},
			renderCall(_args, theme) {
				return new Text(theme.fg("dim", "◆ composing task brief…"), 0, 0);
			},
			renderResult(result, { expanded }, theme) {
				const snapshot = result.details as BriefSnapshot | undefined;
				if (!snapshot?.brief) {
					const first = result.content[0];
					return new Text(
						first?.type === "text" ? first.text : "Brief unavailable",
						0,
						0,
					);
				}
				return createBriefCard(snapshot, expanded, theme);
			},
		});
	}
}

class BriefController {
	private state = emptyState();
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		new BriefPresenter(
			pi,
			() => this.state,
			() => this.persistState(),
			(ctx) => this.updateUi(ctx),
		);
	}

	isActive(): boolean {
		return this.state.active;
	}

	persistState(): void {
		this.pi.appendEntry(STATE_ENTRY, structuredClone(this.state));
	}

	updateUi(ctx: ExtensionContext): void {
		renderBriefModeUi(ctx, this.state);
	}

	clearUi(ctx: ExtensionContext): void {
		clearBriefModeUi(ctx);
	}

	restore(ctx: ExtensionContext): void {
		this.state = latestPersistedState(ctx) ?? emptyState();
		this.updateUi(ctx);
	}

	async restartWithApprovedBrief(ctx: ExtensionCommandContext): Promise<void> {
		if (!this.state.active) {
			ctx.ui.notify(
				"No active brief to approve. Start with /brief <task>.",
				"error",
			);
			return;
		}

		const snapshot = snapshotFromState(this.state);
		if (!snapshot) {
			ctx.ui.notify(
				"No rendered brief to approve. Start with /brief <task>.",
				"error",
			);
			return;
		}

		const validationErrors = validateBrief(snapshot.brief);
		if (validationErrors.length > 0) {
			ctx.ui.notify(
				`Brief is incomplete:\n- ${validationErrors.join("\n- ")}`,
				"error",
			);
			return;
		}

		const prompt = compileBriefPrompt(snapshot.brief);
		const title = snapshot.brief.title.trim();

		this.state.active = false;
		this.state.status = "approved";
		this.persistState();
		this.updateUi(ctx);

		const result = await ctx.newSession({
			setup: (sessionManager) => {
				sessionManager.appendSessionInfo(title);
				return Promise.resolve();
			},
			withSession: async (replacementCtx) => {
				await replacementCtx.sendUserMessage(prompt);
			},
		});

		if (result.cancelled) {
			this.state.active = true;
			this.state.status = "draft";
			this.persistState();
			this.updateUi(ctx);
			ctx.ui.notify(
				"New session was cancelled; brief authoring remains active.",
				"info",
			);
		}
	}

	async startBrief(task: string, ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/brief requires interactive TUI mode.", "error");
			return;
		}
		if (!ctx.model) {
			ctx.ui.notify("Select a model before starting a brief.", "error");
			return;
		}

		if (this.state.active) {
			const replace = await ctx.ui.confirm(
				"Replace active brief?",
				"Starting a new brief will replace the current draft.",
			);
			if (!replace) return;
		}

		this.state.active = true;
		this.state.task = task;
		this.state.revision = 0;
		this.state.draft = undefined;
		this.state.filePath = undefined;
		this.state.status = "draft";
		this.persistState();
		this.updateUi(ctx);

		this.pi.sendUserMessage([
			{
				type: "text",
				text: `Create and render a task brief for the following user intent. Produce a complete first draft now, preserve solution latitude, and surface material uncertainty inside the brief.\n\n${task}`,
			},
		]);
	}

	async handleCommand(
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const command = args.trim();
		if (!command) {
			ctx.ui.notify("Usage: /brief <task>", "info");
			return;
		}

		if (command === INTERNAL_APPROVE_ARGUMENT) {
			await ctx.waitForIdle();
			await this.restartWithApprovedBrief(ctx);
			return;
		}

		await this.startBrief(command, ctx);
	}
}

export default function briefExtension(pi: ExtensionAPI): void {
	const controller = new BriefController(pi);

	pi.registerCommand("brief", {
		description: "Turn a task into a precise brief for a fresh conversation",
		handler: (args, ctx) => controller.handleCommand(args, ctx),
	});

	pi.on("before_agent_start", (event) => {
		if (!controller.isActive()) return;
		return { systemPrompt: `${event.systemPrompt}${BRIEF_MODE_PROMPT}` };
	});

	pi.on("session_start", (_event, ctx) => {
		controller.restore(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		controller.clearUi(ctx);
	});
}
