/**
 * Contract tests for resolveConfigPath: the state-dir default, blank-override
 * fallthrough, host-native absolute and tilde expansion, and cwd-relative
 * resolution. The harness is deterministic — no filesystem or environment
 * access — with host-native path fixtures so the same assertions hold on
 * POSIX and win32 runners.
 */
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigPath } from "./paths.ts";

describe("resolveConfigPath", () => {
	const stateDir = "/home/test/.local/state/eliza";

	it("defaults to eliza.json under the state dir", () => {
		expect(resolveConfigPath({}, stateDir)).toBe(
			path.join(stateDir, "eliza.json"),
		);
	});

	it("ignores a blank ELIZA_CONFIG_PATH override", () => {
		expect(resolveConfigPath({ ELIZA_CONFIG_PATH: "" }, stateDir)).toBe(
			path.join(stateDir, "eliza.json"),
		);
		expect(resolveConfigPath({ ELIZA_CONFIG_PATH: "   " }, stateDir)).toBe(
			path.join(stateDir, "eliza.json"),
		);
	});

	it("resolves an absolute override verbatim", () => {
		// The override must be used as-is (never joined under the state dir);
		// the input is a genuinely host-native absolute (drive root on win32,
		// "/" on POSIX) so verbatim round-trips on every platform.
		const absolute = path.resolve(
			path.parse(process.cwd()).root,
			"etc",
			"eliza",
			"custom.json",
		);
		expect(resolveConfigPath({ ELIZA_CONFIG_PATH: absolute }, stateDir)).toBe(
			absolute,
		);
	});

	it("expands a tilde override to the home directory", () => {
		const out = resolveConfigPath(
			{ ELIZA_CONFIG_PATH: "~/eliza.json" },
			stateDir,
		);
		expect(path.isAbsolute(out)).toBe(true);
		// os.homedir() is the host-native home (USERPROFILE on win32); HOME is
		// frequently unset there, so it cannot drive the expectation.
		expect(out).toBe(path.join(os.homedir(), "eliza.json"));
	});

	it("resolves a relative override against cwd", () => {
		const out = resolveConfigPath(
			{ ELIZA_CONFIG_PATH: "config.json" },
			stateDir,
		);
		expect(path.isAbsolute(out)).toBe(true);
		expect(out).toBe(path.resolve("config.json"));
	});
});
