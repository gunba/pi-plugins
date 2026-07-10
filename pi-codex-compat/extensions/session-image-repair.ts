import { constants } from "node:fs";
import { copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";

import {
	type ImageConverter,
	normalizeProviderImageMessages,
} from "./image-content.ts";

type UnknownRecord = Record<string, unknown>;

export type SessionImageRepairPreview = {
	changedEntries: number;
	changedBlocks: number;
};

export type SessionImageRepairResult = SessionImageRepairPreview & {
	applied: boolean;
	backupPath?: string;
};

type PlannedRepair = SessionImageRepairPreview & {
	originalText: string;
	repairedText: string;
};

function isRecord(value: unknown): value is UnknownRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function changedBlockCount(before: unknown, after: unknown): number {
	if (!Array.isArray(before) || !Array.isArray(after)) {
		return before === after ? 0 : 1;
	}
	const length = Math.max(before.length, after.length);
	let changed = 0;
	for (let index = 0; index < length; index++) {
		if (before[index] !== after[index]) changed += 1;
	}
	return changed;
}

async function normalizeSessionEntry(
	entry: unknown,
	convertImage: ImageConverter,
): Promise<{ entry: unknown; changedBlocks: number }> {
	if (!isRecord(entry)) return { entry, changedBlocks: 0 };

	if (entry.type === "message" && isRecord(entry.message)) {
		const [message] = await normalizeProviderImageMessages(
			[entry.message],
			convertImage,
		);
		if (message === entry.message) return { entry, changedBlocks: 0 };
		return {
			entry: { ...entry, message },
			changedBlocks: changedBlockCount(entry.message.content, message.content),
		};
	}

	if (entry.type === "custom_message") {
		const [normalized] = await normalizeProviderImageMessages(
			[entry],
			convertImage,
		);
		if (normalized === entry) return { entry, changedBlocks: 0 };
		return {
			entry: normalized,
			changedBlocks: changedBlockCount(entry.content, normalized.content),
		};
	}

	return { entry, changedBlocks: 0 };
}

export async function planSessionImageRepair(
	originalText: string,
	convertImage: ImageConverter,
): Promise<PlannedRepair> {
	const newline = originalText.includes("\r\n") ? "\r\n" : "\n";
	const hasFinalNewline = originalText.endsWith("\n");
	const lines = originalText.split(/\r?\n/);
	if (hasFinalNewline) lines.pop();

	let changedEntries = 0;
	let changedBlocks = 0;
	const repairedLines = await Promise.all(
		lines.map(async (line, index) => {
			if (!line.trim()) return line;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Invalid session JSON on line ${index + 1}: ${message}`);
			}

			const normalized = await normalizeSessionEntry(entry, convertImage);
			if (normalized.entry === entry) return line;
			changedEntries += 1;
			changedBlocks += normalized.changedBlocks;
			return JSON.stringify(normalized.entry);
		}),
	);

	const repairedText = repairedLines.join(newline) + (hasFinalNewline ? newline : "");
	return {
		originalText,
		repairedText,
		changedEntries,
		changedBlocks,
	};
}

function backupPathFor(sessionPath: string): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `${sessionPath}.image-repair-${timestamp}-${process.pid}.bak`;
}

export async function repairSessionImageFile(
	sessionPath: string,
	convertImage: ImageConverter,
	approve: (preview: SessionImageRepairPreview) => boolean | Promise<boolean>,
): Promise<SessionImageRepairResult> {
	const originalText = await readFile(sessionPath, "utf8");
	const plan = await planSessionImageRepair(originalText, convertImage);
	const preview = {
		changedEntries: plan.changedEntries,
		changedBlocks: plan.changedBlocks,
	};
	if (plan.changedEntries === 0) return { ...preview, applied: false };
	if (!(await approve(preview))) return { ...preview, applied: false };

	const currentText = await readFile(sessionPath, "utf8");
	if (currentText !== originalText) {
		throw new Error("Session changed while image repair was being prepared; retry the command");
	}

	const backupPath = backupPathFor(sessionPath);
	const temporaryPath = `${sessionPath}.image-repair-${process.pid}-${Date.now()}.tmp`;
	await writeFile(temporaryPath, plan.repairedText, "utf8");
	try {
		await copyFile(sessionPath, backupPath, constants.COPYFILE_EXCL);
		await rename(temporaryPath, sessionPath);
	} catch (error) {
		await rm(temporaryPath, { force: true });
		throw error;
	}

	return { ...preview, applied: true, backupPath };
}
