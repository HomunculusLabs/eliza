/**
 * Atomic JSON read/write helpers (node-only).
 *
 * Consolidates the write-tmp + rename pattern duplicated across the agent
 * package for tokens, ledgers, config snapshots, and runtime operations.
 *
 * Defaults:
 *   - mode 0o600 on the written file (secret-grade)
 *   - dir mode 0o700 when the parent has to be created
 *   - JSON 2-space indent, no trailing newline
 *   - tmp filename `${filePath}.tmp-${pid}-${Date.now()}-${sequence}`
 *   - parent directory created with mkdir recursive
 *
 * On failure, the temp file is best-effort removed.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { logger } from "../logger.js";

export interface WriteJsonAtomicOptions {
	/** File mode for the final file. Default 0o600. */
	mode?: number;
	/** Directory mode if the parent has to be created. Default 0o700. */
	dirMode?: number;
	/** Append a trailing newline. Default false. */
	trailingNewline?: boolean;
	/** `space` arg passed to JSON.stringify. Default 2. */
	indent?: number | string;
	/** Skip mkdir of the parent directory. Default false. */
	skipMkdir?: boolean;
}

interface NormalizedWriteOptions {
	mode: number;
	dirMode: number;
	trailingNewline: boolean;
	indent: number | string;
	skipMkdir: boolean;
}

function normalizeOptions(
	opts: WriteJsonAtomicOptions | undefined,
): NormalizedWriteOptions {
	return {
		mode: opts?.mode ?? 0o600,
		dirMode: opts?.dirMode ?? 0o700,
		trailingNewline: opts?.trailingNewline ?? false,
		indent: opts?.indent ?? 2,
		skipMkdir: opts?.skipMkdir ?? false,
	};
}

let tmpSequenceCounter = 0n;

function tmpPathFor(filePath: string): string {
	tmpSequenceCounter += 1n;
	return `${filePath}.tmp-${process.pid}-${Date.now()}-${tmpSequenceCounter}`;
}

// On Windows, renaming over an existing destination can transiently fail with
// EPERM while another handle holds the target open (antivirus, indexer, or a
// concurrent same-target writer between its write and rename). The replace is
// idempotent from the caller's perspective, so retrying the rename preserves
// last-complete-writer semantics instead of surfacing a transient lock as a
// failed write: every visible destination is still a complete temp-file
// rename, and a call only completes after its rename succeeds. Bounded so a
// genuinely persistent lock still fails fast, and win32-only because on POSIX
// EPERM is a real permission failure that must surface immediately.
const RENAME_EPERM_RETRY_DELAY_MS = 25;
const RENAME_EPERM_MAX_ATTEMPTS = 40;

function isTransientRenameError(error: unknown): boolean {
	return (
		process.platform === "win32" &&
		(error as NodeJS.ErrnoException | null)?.code === "EPERM"
	);
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function renameWithWindowsRetry(
	tmp: string,
	filePath: string,
): Promise<void> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			await fsp.rename(tmp, filePath);
			return;
		} catch (error) {
			// error-policy:J4 user-facing degrade — a transient win32
			// destination lock is an expected error shape ridden out with a
			// bounded retry; exhaustion rethrows the original failure.
			if (
				!isTransientRenameError(error) ||
				attempt >= RENAME_EPERM_MAX_ATTEMPTS
			) {
				throw error;
			}
			await new Promise((resolve) =>
				setTimeout(resolve, RENAME_EPERM_RETRY_DELAY_MS),
			);
		}
	}
}

function renameSyncWithWindowsRetry(tmp: string, filePath: string): void {
	for (let attempt = 1; ; attempt += 1) {
		try {
			fs.renameSync(tmp, filePath);
			return;
		} catch (error) {
			// error-policy:J4 user-facing degrade — synchronous mirror of the
			// bounded win32 transient-lock retry above; exhaustion rethrows.
			if (
				!isTransientRenameError(error) ||
				attempt >= RENAME_EPERM_MAX_ATTEMPTS
			) {
				throw error;
			}
			sleepSync(RENAME_EPERM_RETRY_DELAY_MS);
		}
	}
}

function serialize(value: unknown, opts: NormalizedWriteOptions): string {
	const body = JSON.stringify(value, null, opts.indent);
	return opts.trailingNewline ? `${body}\n` : body;
}

function assertFilePath(filePath: string): void {
	if (typeof filePath !== "string" || filePath.trim().length === 0) {
		throw new TypeError("filePath must be a non-empty string");
	}
}

export async function writeJsonAtomic(
	filePath: string,
	value: unknown,
	opts?: WriteJsonAtomicOptions,
): Promise<void> {
	assertFilePath(filePath);
	const o = normalizeOptions(opts);
	if (!o.skipMkdir) {
		await fsp.mkdir(path.dirname(filePath), {
			recursive: true,
			mode: o.dirMode,
		});
	}
	const tmp = tmpPathFor(filePath);
	try {
		await fsp.writeFile(tmp, serialize(value, o), {
			encoding: "utf-8",
			mode: o.mode,
			flag: "wx",
		});
		await renameWithWindowsRetry(tmp, filePath);
	} finally {
		try {
			await fsp.rm(tmp, { force: true });
		} catch (error) {
			// error-policy:J6 best-effort teardown — a stranded temporary file is
			// observable but must not mask the original write/rename failure.
			logger.warn(
				{
					file: tmp,
					error: error instanceof Error ? error.message : String(error),
				},
				"[AtomicJson] Failed to remove temporary file",
			);
		}
	}
}

export function writeJsonAtomicSync(
	filePath: string,
	value: unknown,
	opts?: WriteJsonAtomicOptions,
): void {
	assertFilePath(filePath);
	const o = normalizeOptions(opts);
	if (!o.skipMkdir) {
		fs.mkdirSync(path.dirname(filePath), {
			recursive: true,
			mode: o.dirMode,
		});
	}
	const tmp = tmpPathFor(filePath);
	try {
		fs.writeFileSync(tmp, serialize(value, o), {
			encoding: "utf-8",
			mode: o.mode,
			flag: "wx",
		});
		renameSyncWithWindowsRetry(tmp, filePath);
	} finally {
		try {
			fs.rmSync(tmp, { force: true });
		} catch (error) {
			// error-policy:J6 best-effort teardown — see the asynchronous path above.
			logger.warn(
				{
					file: tmp,
					error: error instanceof Error ? error.message : String(error),
				},
				"[AtomicJson] Failed to remove temporary file",
			);
		}
	}
}

/**
 * Read and parse JSON. Only a genuinely absent file returns `null`; malformed
 * JSON and filesystem failures surface to the caller.
 */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
	assertFilePath(filePath);
	try {
		const raw = await fsp.readFile(filePath, "utf-8");
		return JSON.parse(raw) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			// error-policy:J4 an absent optional JSON file is an explicit not-found
			// state; parse and other filesystem failures still propagate.
			return null;
		}
		throw error;
	}
}

/**
 * Synchronous read and parse JSON. Only a genuinely absent file returns `null`;
 * malformed JSON and filesystem failures surface to the caller.
 */
export function readJsonFileSync<T>(filePath: string): T | null {
	assertFilePath(filePath);
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			// error-policy:J4 an absent optional JSON file is an explicit not-found
			// state; parse and other filesystem failures still propagate.
			return null;
		}
		throw error;
	}
}
