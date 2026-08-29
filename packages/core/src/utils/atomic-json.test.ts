/**
 * Unit tests for atomic-json read/write helpers in packages/core/src/utils/atomic-json.ts.
 * Exercises async/sync atomic write, async/sync json reading, ENOENT handling, and malformed JSON errors.
 */

import type { PathLike } from "node:fs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	readJsonFile,
	readJsonFileSync,
	writeJsonAtomic,
	writeJsonAtomicSync,
} from "./atomic-json";

function createDeferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("atomic-json", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "atomic-json-test-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	describe("writeJsonAtomic & readJsonFile (async)", () => {
		it("writes and reads json data atomically", async () => {
			const target = path.join(tempDir, "nested", "data.json");
			const payload = { hello: "world", count: 42, flag: true };

			await writeJsonAtomic(target, payload);
			const readBack = await readJsonFile<typeof payload>(target);

			expect(readBack).toEqual(payload);
		});

		it("returns null for non-existent files (ENOENT)", async () => {
			const missing = path.join(tempDir, "non-existent.json");
			const result = await readJsonFile(missing);
			expect(result).toBeNull();
		});

		it("throws for malformed JSON", async () => {
			const broken = path.join(tempDir, "broken.json");
			await fsp.writeFile(broken, "{ invalid json", "utf-8");

			await expect(readJsonFile(broken)).rejects.toThrow(SyntaxError);
		});

		it("supports custom formatting options like trailingNewline and indent", async () => {
			const target = path.join(tempDir, "formatted.json");
			await writeJsonAtomic(
				target,
				{ a: 1 },
				{ trailingNewline: true, indent: 4 },
			);

			const raw = await fsp.readFile(target, "utf-8");
			expect(raw).toBe('{\n    "a": 1\n}\n');
		});
	});

	describe("writeJsonAtomicSync & readJsonFileSync (sync)", () => {
		it("writes and reads json data synchronously", () => {
			const target = path.join(tempDir, "sync-nested", "data.json");
			const payload = { name: "eliza", items: [1, 2, 3] };

			writeJsonAtomicSync(target, payload);
			const readBack = readJsonFileSync<typeof payload>(target);

			expect(readBack).toEqual(payload);
		});

		it("returns null for non-existent files (ENOENT)", () => {
			const missing = path.join(tempDir, "missing-sync.json");
			const result = readJsonFileSync(missing);
			expect(result).toBeNull();
		});

		it("throws for malformed JSON", () => {
			const broken = path.join(tempDir, "broken-sync.json");
			fs.writeFileSync(broken, "not valid json {", "utf-8");

			expect(() => readJsonFileSync(broken)).toThrow(SyntaxError);
		});

		it("supports custom formatting options synchronously", () => {
			const target = path.join(tempDir, "sync-formatted.json");
			writeJsonAtomicSync(
				target,
				{ b: 2 },
				{ trailingNewline: true, indent: 0 },
			);

			const raw = fs.readFileSync(target, "utf-8");
			expect(raw).toBe('{"b":2}\n');
		});
	});

	describe("concurrency and validation", () => {
		it("handles concurrent same-target writes in the same millisecond", async () => {
			vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
			const target = path.join(tempDir, "concurrent.json");
			const writes = Array.from({ length: 20 }, (_, index) =>
				writeJsonAtomic(target, { index }),
			);

			await Promise.all(writes);

			const readBack = await readJsonFile<{ index: number }>(target);
			expect(readBack?.index).toBeGreaterThanOrEqual(0);
			expect(readBack?.index).toBeLessThan(20);
			expect((await fsp.readdir(tempDir)).sort()).toEqual(["concurrent.json"]);
		});

		it("serializes same-target writes end to end", async () => {
			const target = path.join(tempDir, "serialized.json");
			const firstWriteEntered = createDeferred();
			let releaseGate!: () => void;
			const gate = new Promise<void>((resolve) => {
				releaseGate = resolve;
			});
			let active = 0;
			let maxConcurrent = 0;
			let renameCalls = 0;
			let writeFileCalls = 0;
			const realRename = fsp.rename;
			const renameSpy = vi
				.spyOn(fsp, "rename")
				.mockImplementation(async (from: PathLike, to: PathLike) => {
					renameCalls += 1;
					active += 1;
					maxConcurrent = Math.max(maxConcurrent, active);
					try {
						return await realRename(from, to);
					} finally {
						active -= 1;
					}
				});
			const realWriteFile = fsp.writeFile;
			const writeSpy = vi
				.spyOn(fsp, "writeFile")
				.mockImplementation(
					async (...args: Parameters<typeof fsp.writeFile>) => {
						writeFileCalls += 1;
						if (writeFileCalls === 1) {
							firstWriteEntered.resolve();
							await gate;
						}
						return realWriteFile(...args);
					},
				);

			const first = writeJsonAtomic(target, { index: 0 });
			await firstWriteEntered.promise;
			const second = writeJsonAtomic(target, { index: 1 });
			// One macrotask tick: deterministically flushes every pending
			// microtask continuation (including a write that is NOT queued),
			// so the assertions below can only pass when serialization holds.
			await new Promise((resolve) => setTimeout(resolve, 0));
			// Deterministic: the second write cannot start (no second temp
			// writeFile, no rename) while the first write is gated mid-flight.
			expect(renameCalls).toBe(0);
			expect(writeFileCalls).toBe(1);

			releaseGate();
			await Promise.all([first, second]);
			await Promise.all(
				Array.from({ length: 6 }, (_, index) =>
					writeJsonAtomic(target, { index }),
				),
			);

			renameSpy.mockRestore();
			writeSpy.mockRestore();
			expect(maxConcurrent).toBe(1);
			expect(await readJsonFile(target)).toBeDefined();
			expect((await fsp.readdir(tempDir)).sort()).toEqual(["serialized.json"]);
		});

		it("keeps different-target commits parallel", async () => {
			const allEntered = createDeferred();
			let entered = 0;
			let active = 0;
			let maxConcurrent = 0;
			const realRename = fsp.rename;
			const renameSpy = vi
				.spyOn(fsp, "rename")
				.mockImplementation(async (from: PathLike, to: PathLike) => {
					entered += 1;
					active += 1;
					maxConcurrent = Math.max(maxConcurrent, active);
					if (entered === 4) {
						allEntered.resolve();
					}
					try {
						await allEntered.promise;
						return await realRename(from, to);
					} finally {
						active -= 1;
					}
				});

			await Promise.all(
				Array.from({ length: 4 }, (_, index) =>
					writeJsonAtomic(path.join(tempDir, `parallel-${index}.json`), {
						index,
					}),
				),
			);

			renameSpy.mockRestore();
			expect(maxConcurrent).toBe(4);
			for (let index = 0; index < 4; index += 1) {
				const readBack = await readJsonFile<{ index: number }>(
					path.join(tempDir, `parallel-${index}.json`),
				);
				expect(readBack?.index).toBe(index);
			}
		});

		it("lets a queued follower write after an earlier write rejects", async () => {
			const target = path.join(tempDir, "recover.json");
			const firstWriteEntered = createDeferred();
			const secondStarted = createDeferred();
			let releaseGate!: () => void;
			const gate = new Promise<void>((resolve) => {
				releaseGate = resolve;
			});
			const realRename = fsp.rename;
			const realWriteFile = fsp.writeFile;
			let writeFileCalls = 0;
			const renameSpy = vi
				.spyOn(fsp, "rename")
				.mockImplementation(async (from: PathLike, to: PathLike) => {
					if (writeFileCalls === 1) {
						await gate;
						throw Object.assign(new Error("EPERM: rename race"), {
							code: "EPERM",
						});
					}
					return realRename(from, to);
				});
			const writeSpy = vi
				.spyOn(fsp, "writeFile")
				.mockImplementation(
					async (...args: Parameters<typeof fsp.writeFile>) => {
						writeFileCalls += 1;
						if (writeFileCalls === 1) {
							firstWriteEntered.resolve();
						} else if (writeFileCalls === 2) {
							secondStarted.resolve();
						}
						return realWriteFile(...args);
					},
				);

			const failing = writeJsonAtomic(target, { attempt: 1 });
			await firstWriteEntered.promise;
			const follower = writeJsonAtomic(target, { attempt: 2 });
			// The follower is queued behind the still-pending first write; it
			// cannot start its own temp write while the first commit is gated.
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(writeFileCalls).toBe(1);

			releaseGate();
			await expect(failing).rejects.toThrow(/EPERM/);
			await secondStarted.promise;
			await follower;

			renameSpy.mockRestore();
			writeSpy.mockRestore();
			expect(await readJsonFile<{ attempt: number }>(target)).toEqual({
				attempt: 2,
			});
			expect((await fsp.readdir(tempDir)).sort()).toEqual(["recover.json"]);
		});

		it("folds the write key on windows so differently-cased spellings share one queue", async () => {
			const platformDescriptor = Object.getOwnPropertyDescriptor(
				process,
				"platform",
			);
			Object.defineProperty(process, "platform", {
				value: "win32",
				configurable: true,
			});
			const firstWriteEntered = createDeferred();
			let releaseGate!: () => void;
			const gate = new Promise<void>((resolve) => {
				releaseGate = resolve;
			});
			const realWriteFile = fsp.writeFile;
			const realMkdir = fsp.mkdir;
			let writeFileCalls = 0;
			let mkdirCalls = 0;
			const events: string[] = [];
			const mkdirSpy = vi
				.spyOn(fsp, "mkdir")
				.mockImplementation(async (...args: Parameters<typeof fsp.mkdir>) => {
					mkdirCalls += 1;
					return realMkdir(...args);
				});
			const writeSpy = vi
				.spyOn(fsp, "writeFile")
				.mockImplementation(
					async (...args: Parameters<typeof fsp.writeFile>) => {
						writeFileCalls += 1;
						events.push(`w${writeFileCalls}-start`);
						if (writeFileCalls === 1) {
							firstWriteEntered.resolve();
							await gate;
						}
						const result = await realWriteFile(...args);
						if (writeFileCalls === 1) {
							events.push("w1-end");
						}
						return result;
					},
				);
			try {
				const first = writeJsonAtomic(path.join(tempDir, "alias.json"), 1);
				await firstWriteEntered.promise;
				const second = writeJsonAtomic(path.join(tempDir, "ALIAS.json"), 2);
				// One macrotask tick flushes every pending microtask, so a
				// write whose body is NOT queued would have started (its mkdir
				// runs synchronously at body entry).
				await new Promise((resolve) => setTimeout(resolve, 0));
				// Uppercased win32 keys share the queue: the differently-cased
				// target's write body has not started (only w1's mkdir ran)
				// while the first write is gated mid-flight.
				expect(mkdirCalls).toBe(1);
				expect(events).toEqual(["w1-start"]);

				releaseGate();
				await Promise.all([first, second]);
				expect(mkdirCalls).toBe(2);
				expect(events).toEqual(["w1-start", "w1-end", "w2-start"]);
			} finally {
				if (platformDescriptor) {
					Object.defineProperty(process, "platform", platformDescriptor);
				}
				writeSpy.mockRestore();
				mkdirSpy.mockRestore();
			}
		});

		it("folds the win32 write key with the uppercase table, not contextual lowercase", async () => {
			const platformDescriptor = Object.getOwnPropertyDescriptor(
				process,
				"platform",
			);
			Object.defineProperty(process, "platform", {
				value: "win32",
				configurable: true,
			});
			const firstWriteEntered = createDeferred();
			let releaseGate!: () => void;
			const gate = new Promise<void>((resolve) => {
				releaseGate = resolve;
			});
			const realWriteFile = fsp.writeFile;
			const realMkdir = fsp.mkdir;
			let writeFileCalls = 0;
			let mkdirCalls = 0;
			const events: string[] = [];
			const mkdirSpy = vi
				.spyOn(fsp, "mkdir")
				.mockImplementation(async (...args: Parameters<typeof fsp.mkdir>) => {
					mkdirCalls += 1;
					return realMkdir(...args);
				});
			const writeSpy = vi
				.spyOn(fsp, "writeFile")
				.mockImplementation(
					async (...args: Parameters<typeof fsp.writeFile>) => {
						writeFileCalls += 1;
						events.push(`w${writeFileCalls}-start`);
						if (writeFileCalls === 1) {
							firstWriteEntered.resolve();
							await gate;
						}
						const result = await realWriteFile(...args);
						if (writeFileCalls === 1) {
							events.push("w1-end");
						}
						return result;
					},
				);
			try {
				// Windows compares filenames with the ordinal upcase table:
				// data-ΟΣ and data-οσ name one file. Contextual toLowerCase
				// maps the word-final sigma to ς (data-ος vs data-οσ) and
				// splits the queue, starting the second spelling while the
				// first is still gated mid-flight; toUpperCase folds both to
				// DATA-ΟΣ.
				const first = writeJsonAtomic(path.join(tempDir, "data-ΟΣ"), 1);
				await firstWriteEntered.promise;
				const second = writeJsonAtomic(path.join(tempDir, "data-οσ"), 2);
				await new Promise((resolve) => setTimeout(resolve, 0));
				// Same uppercase key: the second spelling's write body has
				// not started while the first write is gated.
				expect(mkdirCalls).toBe(1);
				expect(events).toEqual(["w1-start"]);

				releaseGate();
				await Promise.all([first, second]);
				expect(mkdirCalls).toBe(2);
				expect(events).toEqual(["w1-start", "w1-end", "w2-start"]);
			} finally {
				if (platformDescriptor) {
					Object.defineProperty(process, "platform", platformDescriptor);
				}
				writeSpy.mockRestore();
			}
		});

		it("rejects non-string or empty file paths", async () => {
			await expect(
				writeJsonAtomic("" as unknown as string, {}),
			).rejects.toThrow(TypeError);
			await expect(
				writeJsonAtomic(null as unknown as string, {}),
			).rejects.toThrow(TypeError);
			expect(() => writeJsonAtomicSync("" as unknown as string, {})).toThrow(
				TypeError,
			);
			await expect(readJsonFile("" as unknown as string)).rejects.toThrow(
				TypeError,
			);
			expect(() => readJsonFileSync("" as unknown as string)).toThrow(
				TypeError,
			);
		});
	});
});
