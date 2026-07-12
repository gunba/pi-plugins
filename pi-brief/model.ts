interface BriefScope {
	included: string[];
	excluded: string[];
	assumptions: string[];
}

interface BriefRequirements {
	must: string[];
	should: string[];
	may: string[];
	mustNot: string[];
}

interface BriefTimeHorizon {
	expectedDuration: string;
	minimumEffort: string;
	persistenceRules: string[];
	returnPolicy: string;
}

interface BriefCompletion {
	successConditions: string[];
	stopConditions: string[];
	blockerPolicy: string;
	partialWorkPolicy: string;
}

export interface BriefDocument {
	title: string;
	mission: string;
	motivation: string;
	userVisibleOutcome: string;
	definitions: string[];
	scope: BriefScope;
	requirements: BriefRequirements;
	acceptanceCriteria: string[];
	nonGoals: string[];
	edgeCases: string[];
	constraintsAndTradeoffs: string[];
	openQuestions: string[];
	process: string[];
	timeHorizon: BriefTimeHorizon;
	verification: string[];
	deliverables: string[];
	interactionRules: string[];
	completion: BriefCompletion;
	sourcesAndTools: string[];
}

export interface BriefSnapshot {
	brief: BriefDocument;
	revision: number;
	status: "draft" | "approved";
	task: string;
	updatedAt: number;
	filePath?: string;
}

export interface BriefSessionState {
	active: boolean;
	task?: string;
	revision: number;
	draft?: BriefDocument;
	status: "draft" | "approved";
	toolsBeforeBrief?: string[];
	filePath?: string;
}

const REQUIRED_TEXT_FIELDS: Array<
	keyof Pick<
		BriefDocument,
		"title" | "mission" | "motivation" | "userVisibleOutcome"
	>
> = ["title", "mission", "motivation", "userVisibleOutcome"];

export function validateBrief(brief: BriefDocument): string[] {
	const errors: string[] = [];

	for (const field of REQUIRED_TEXT_FIELDS) {
		if (!brief[field].trim()) errors.push(`${field} must not be empty`);
	}

	const requiredLists: Array<[string, string[]]> = [
		["requirements.must", brief.requirements.must],
		["acceptanceCriteria", brief.acceptanceCriteria],
		["process", brief.process],
		["timeHorizon.persistenceRules", brief.timeHorizon.persistenceRules],
		["verification", brief.verification],
		["deliverables", brief.deliverables],
		["completion.successConditions", brief.completion.successConditions],
		["completion.stopConditions", brief.completion.stopConditions],
	];

	for (const [name, values] of requiredLists) {
		if (values.length === 0 || values.every((value) => !value.trim())) {
			errors.push(`${name} must contain at least one substantive item`);
		}
	}

	const requiredPolicies: Array<[string, string]> = [
		["timeHorizon.expectedDuration", brief.timeHorizon.expectedDuration],
		["timeHorizon.minimumEffort", brief.timeHorizon.minimumEffort],
		["timeHorizon.returnPolicy", brief.timeHorizon.returnPolicy],
		["completion.blockerPolicy", brief.completion.blockerPolicy],
		["completion.partialWorkPolicy", brief.completion.partialWorkPolicy],
	];

	for (const [name, value] of requiredPolicies) {
		if (!value.trim()) errors.push(`${name} must not be empty`);
	}

	return errors;
}

function section(title: string, body: string): string {
	return `## ${title}\n\n${body.trim()}`;
}

function bullets(values: string[], empty = "None specified."): string {
	const substantive = values.map((value) => value.trim()).filter(Boolean);
	return substantive.length > 0
		? substantive.map((value) => `- ${value}`).join("\n")
		: empty;
}

function requirementGroup(label: string, values: string[]): string {
	return `### ${label}\n\n${bullets(values)}`;
}

export function compileBriefPrompt(brief: BriefDocument): string {
	const sections = [
		`# ${brief.title.trim()}`,
		"Treat this brief as the authoritative task specification. Complete the requested outcome without silently narrowing the scope, substituting a nearby result, or stopping merely because an approach fails. Follow the stated process, time horizon, verification requirements, and completion policy.",
		section("Mission", brief.mission),
		section("Context and motivation", brief.motivation),
		section("User-visible outcome", brief.userVisibleOutcome),
		section("Definitions", bullets(brief.definitions)),
		section(
			"Scope",
			[
				requirementGroup("Included", brief.scope.included),
				requirementGroup("Excluded", brief.scope.excluded),
				requirementGroup("Assumptions", brief.scope.assumptions),
			].join("\n\n"),
		),
		section(
			"Requirements",
			[
				requirementGroup("Must", brief.requirements.must),
				requirementGroup("Should", brief.requirements.should),
				requirementGroup("May", brief.requirements.may),
				requirementGroup("Must not", brief.requirements.mustNot),
			].join("\n\n"),
		),
		section("Acceptance criteria", bullets(brief.acceptanceCriteria)),
		section("Non-goals and near-miss exclusions", bullets(brief.nonGoals)),
		section("Edge cases and failure modes", bullets(brief.edgeCases)),
		section(
			"Constraints and trade-offs",
			bullets(brief.constraintsAndTradeoffs),
		),
		section("Required process", bullets(brief.process)),
		section(
			"Time horizon and persistence",
			[
				`**Expected duration:** ${brief.timeHorizon.expectedDuration.trim()}`,
				`**Minimum effort before returning:** ${brief.timeHorizon.minimumEffort.trim()}`,
				requirementGroup(
					"Persistence rules",
					brief.timeHorizon.persistenceRules,
				),
				`**Return policy:** ${brief.timeHorizon.returnPolicy.trim()}`,
			].join("\n\n"),
		),
		section("Verification and adversarial audit", bullets(brief.verification)),
		section("Deliverables", bullets(brief.deliverables)),
		section(
			"Interaction and escalation rules",
			bullets(brief.interactionRules),
		),
		section(
			"Completion and stopping conditions",
			[
				requirementGroup(
					"Success conditions",
					brief.completion.successConditions,
				),
				requirementGroup(
					"Permitted stopping conditions",
					brief.completion.stopConditions,
				),
				`**Blocker policy:** ${brief.completion.blockerPolicy.trim()}`,
				`**Partial-work policy:** ${brief.completion.partialWorkPolicy.trim()}`,
			].join("\n\n"),
		),
		section("Sources and tools", bullets(brief.sourcesAndTools)),
	];

	if (brief.openQuestions.some((question) => question.trim())) {
		sections.push(
			section(
				"Decisions already deferred to the executing agent",
				bullets(brief.openQuestions),
			),
		);
	}

	sections.push(
		"Do not claim completion until every success condition and acceptance criterion has been satisfied and the specified verification has passed. If an unforeseen conflict makes the brief impossible to satisfy, stop and ask the user to resolve that conflict rather than returning a contradictory or partial substitute.",
	);

	return `${sections.join("\n\n")}\n`;
}

export function snapshotFromState(
	state: BriefSessionState,
): BriefSnapshot | undefined {
	if (!state.task || !state.draft) return undefined;
	return {
		brief: state.draft,
		revision: state.revision,
		status: state.status,
		task: state.task,
		updatedAt: Date.now(),
		filePath: state.filePath,
	};
}
