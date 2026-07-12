import assert from "node:assert/strict";
import test from "node:test";

import {
	compileBriefPrompt,
	snapshotFromState,
	validateBrief,
} from "../model.ts";

function completeBrief() {
	return {
		title: "Recover accounts without support",
		mission: "Provide a secure self-service account recovery flow.",
		motivation: "Users are currently blocked until support intervenes.",
		userVisibleOutcome:
			"A legitimate user can regain access without staff assistance.",
		definitions: [
			"Recovery means restoring access without revealing an existing secret.",
		],
		scope: {
			included: ["Existing password-based accounts"],
			excluded: ["Anonymous sessions"],
			assumptions: ["A verified recovery channel exists"],
		},
		requirements: {
			must: ["Resist account takeover"],
			should: ["Complete in one user session"],
			may: ["Use an expiring recovery link"],
			mustNot: ["Expose whether an account exists"],
		},
		acceptanceCriteria: ["A legitimate user can recover access end to end"],
		nonGoals: [
			"A manual database reset does not count as self-service recovery",
		],
		edgeCases: ["Expired and replayed recovery tokens"],
		constraintsAndTradeoffs: [
			"Security takes precedence over reducing one interaction",
		],
		openQuestions: [],
		process: [
			"Model threats",
			"Design the flow",
			"Implement",
			"Audit adversarially",
		],
		timeHorizon: {
			expectedDuration: "Two focused engineering days",
			minimumEffort:
				"Complete the threat model and two adversarial review rounds before returning",
			persistenceRules: [
				"Try an alternate design if the first cannot satisfy the threat model",
			],
			returnPolicy:
				"Return only after every acceptance criterion and audit check passes.",
		},
		verification: [
			"Attempt replay, enumeration, and token substitution attacks",
		],
		deliverables: ["Working recovery flow", "Automated security tests"],
		interactionRules: [
			"Ask the user if a required recovery channel does not exist",
		],
		completion: {
			successConditions: ["All supported accounts can recover securely"],
			stopConditions: [
				"Complete success",
				"An unforeseen requirement conflict requiring user resolution",
			],
			blockerPolicy:
				"Stop and ask the user to resolve an impossible or conflicting requirement.",
			partialWorkPolicy:
				"Do not return partial recovery, manual substitutes, or best-effort work as completion.",
		},
		sourcesAndTools: [
			"Use the repository's established security and test tooling",
		],
	};
}

test("compileBriefPrompt preserves process, time horizon, audit, and no-partial policies", () => {
	const prompt = compileBriefPrompt(completeBrief());

	assert.match(prompt, /^# Recover accounts without support/m);
	assert.match(prompt, /## Required process/);
	assert.match(prompt, /Two focused engineering days/);
	assert.match(prompt, /two adversarial review rounds/);
	assert.match(prompt, /## Verification and adversarial audit/);
	assert.match(prompt, /Do not return partial recovery/);
	assert.match(prompt, /manual database reset does not count/);
	assert.match(prompt, /Do not claim completion until every success condition/);
	assert.doesNotMatch(prompt, /Decisions already deferred/);
});

test("compileBriefPrompt carries unresolved decisions into the executing conversation", () => {
	const brief = completeBrief();
	brief.openQuestions = [
		"Choose the recovery channel using the safest repository-supported option",
	];
	const prompt = compileBriefPrompt(brief);

	assert.match(prompt, /## Decisions already deferred to the executing agent/);
	assert.match(prompt, /safest repository-supported option/);
});

test("validateBrief rejects drafts without process, time horizon, or completion policy", () => {
	const brief = completeBrief();
	brief.process = [];
	brief.timeHorizon.minimumEffort = "";
	brief.completion.partialWorkPolicy = "";

	assert.deepEqual(validateBrief(brief), [
		"process must contain at least one substantive item",
		"timeHorizon.minimumEffort must not be empty",
		"completion.partialWorkPolicy must not be empty",
	]);
});

test("snapshotFromState emits only complete rendered state", () => {
	assert.equal(
		snapshotFromState({ active: true, revision: 0, status: "draft" }),
		undefined,
	);

	const brief = completeBrief();
	const snapshot = snapshotFromState({
		active: true,
		task: "Add account recovery",
		revision: 3,
		draft: brief,
		status: "draft",
	});

	assert.equal(snapshot?.revision, 3);
	assert.equal(snapshot?.task, "Add account recovery");
	assert.equal(snapshot?.brief, brief);
});
