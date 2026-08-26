/**
 * Deterministic unit coverage for secret-driven plugin activation concurrency.
 * A mocked SecretsService controls readiness while the real activator service
 * runs its interval and secret-change entrypoints under fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createMockRuntime,
	MOCK_AGENT_ID,
} from "../../../testing/mock-runtime.ts";
import type { IAgentRuntime } from "../../../types/index.ts";
import type {
	PluginSecretRequirement,
	SecretChangeCallback,
	SecretContext,
} from "../types.ts";
import {
	PluginActivatorService,
	type PluginWithSecrets,
} from "./plugin-activator.ts";
import type { SecretsService } from "./secrets.ts";

const PLUGIN: PluginWithSecrets = {
	name: "concurrency-test-plugin",
	description: "Exercises secret-driven activation concurrency.",
	requiredSecrets: {
		TOKEN: {
			description: "Test token",
			type: "token",
			required: true,
		},
	},
};

const GLOBAL_CONTEXT: SecretContext = {
	level: "global",
	agentId: MOCK_AGENT_ID,
	requesterId: MOCK_AGENT_ID,
};

interface ActivatorHarness {
	emitSecretChange: () => Promise<void>;
	reportError: ReturnType<typeof vi.fn>;
	service: PluginActivatorService;
}

async function createHarness(
	getMissingSecrets: (keys: string[]) => Promise<string[]>,
	checkPluginRequirements?: (
		pluginId: string,
		requirements: Record<string, PluginSecretRequirement>,
	) => Promise<{
		ready: boolean;
		missingRequired: string[];
		missingOptional: string[];
		invalid: string[];
	}>,
): Promise<ActivatorHarness> {
	let secretChangeCallback: SecretChangeCallback | undefined;
	const secretsService = {
		checkPluginRequirements: vi.fn(
			checkPluginRequirements ??
				(async () => ({
					ready: false,
					missingRequired: ["TOKEN"],
					missingOptional: [],
					invalid: [],
				})),
		),
		getMissingSecrets: vi.fn(getMissingSecrets),
		onAnySecretChanged: vi.fn((callback: SecretChangeCallback) => {
			secretChangeCallback = callback;
			return () => undefined;
		}),
	} satisfies Pick<
		SecretsService,
		"checkPluginRequirements" | "getMissingSecrets" | "onAnySecretChanged"
	>;
	const reportError = vi.fn();
	const runtime = createMockRuntime({
		getService: (() =>
			secretsService as SecretsService) as IAgentRuntime["getService"],
		reportError,
	});
	const service = await PluginActivatorService.start(runtime, {
		enableAutoActivation: true,
		pollingIntervalMs: 1,
	});

	return {
		service,
		reportError,
		emitSecretChange: async () => {
			if (!secretChangeCallback) {
				throw new Error("Secret-change callback was not registered");
			}
			await secretChangeCallback("TOKEN", "ready", GLOBAL_CONTEXT);
		},
	};
}

describe("PluginActivatorService concurrency", () => {
	let activeService: PluginActivatorService | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(async () => {
		await activeService?.stop();
		activeService = undefined;
		vi.useRealTimers();
	});

	it("joins polling and secret-change activation into one attempt", async () => {
		let releaseActivation: (() => void) | undefined;
		const activationGate = new Promise<void>((resolve) => {
			releaseActivation = resolve;
		});
		let markActivationStarted: (() => void) | undefined;
		const activationStarted = new Promise<void>((resolve) => {
			markActivationStarted = resolve;
		});
		const activation = vi.fn(async () => {
			markActivationStarted?.();
			await activationGate;
		});
		const harness = await createHarness(async () => []);
		activeService = harness.service;

		expect(await harness.service.registerPlugin(PLUGIN, activation)).toBe(
			false,
		);
		const secretChange = harness.emitSecretChange();
		await activationStarted;

		await vi.advanceTimersByTimeAsync(5);
		expect(activation).toHaveBeenCalledTimes(1);

		releaseActivation?.();
		await secretChange;
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.service.isActivated(PLUGIN.name)).toBe(true);
	});

	it("serializes polls, reports failures, and retries activation", async () => {
		let releaseFirstPoll: ((missing: string[]) => void) | undefined;
		const firstPoll = new Promise<string[]>((resolve) => {
			releaseFirstPoll = resolve;
		});
		const pollFailure = new Error("secret lookup unavailable");
		let pollCalls = 0;
		let concurrentPolls = 0;
		let maxConcurrentPolls = 0;
		const getMissingSecrets = vi.fn(async () => {
			pollCalls += 1;
			concurrentPolls += 1;
			maxConcurrentPolls = Math.max(maxConcurrentPolls, concurrentPolls);
			try {
				if (pollCalls === 1) return await firstPoll;
				if (pollCalls === 2) throw pollFailure;
				return [];
			} finally {
				concurrentPolls -= 1;
			}
		});
		const activationFailure = new Error("plugin startup failed");
		const activation = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(activationFailure)
			.mockResolvedValueOnce(undefined);
		const harness = await createHarness(getMissingSecrets);
		activeService = harness.service;
		expect(await harness.service.registerPlugin(PLUGIN, activation)).toBe(
			false,
		);

		await vi.advanceTimersByTimeAsync(1);
		await vi.advanceTimersByTimeAsync(5);
		expect(getMissingSecrets).toHaveBeenCalledTimes(1);
		expect(maxConcurrentPolls).toBe(1);

		releaseFirstPoll?.(["TOKEN"]);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(harness.reportError).toHaveBeenCalledWith(
			"PluginActivator.poll",
			pollFailure,
		);

		await vi.advanceTimersByTimeAsync(1);
		expect(activation).toHaveBeenCalledTimes(1);
		expect(harness.service.isPending(PLUGIN.name)).toBe(true);

		await vi.advanceTimersByTimeAsync(1);
		expect(activation).toHaveBeenCalledTimes(2);
		expect(harness.service.isActivated(PLUGIN.name)).toBe(true);
		expect(maxConcurrentPolls).toBe(1);
	});

	it("does not activate a plugin after stop is requested during a poll lookup", async () => {
		let releaseLookup: ((missing: string[]) => void) | undefined;
		const lookupGate = new Promise<string[]>((resolve) => {
			releaseLookup = resolve;
		});
		const activation = vi.fn(async () => undefined);
		const harness = await createHarness(() => lookupGate);
		activeService = harness.service;
		expect(await harness.service.registerPlugin(PLUGIN, activation)).toBe(
			false,
		);

		// One poll tick suspends inside getMissingSecrets.
		await vi.advanceTimersByTimeAsync(1);

		// Shutdown begins while the lookup is suspended; secrets resolve only
		// after stop was requested.
		const stopping = harness.service.stop();
		releaseLookup?.([]);
		await stopping;
		await vi.advanceTimersByTimeAsync(0);

		expect(activation).not.toHaveBeenCalled();
		expect(harness.service.isPending(PLUGIN.name)).toBe(false);
	});

	it("does not activate a plugin after stop is requested during a secret-change lookup", async () => {
		let releasePoll: ((missing: string[]) => void) | undefined;
		const pollGate = new Promise<string[]>((resolve) => {
			releasePoll = resolve;
		});
		let releaseChange: ((missing: string[]) => void) | undefined;
		const changeGate = new Promise<string[]>((resolve) => {
			releaseChange = resolve;
		});
		let lookupCalls = 0;
		const activation = vi.fn(async () => undefined);
		const harness = await createHarness(() => {
			lookupCalls += 1;
			return lookupCalls === 1 ? pollGate : changeGate;
		});
		activeService = harness.service;
		expect(await harness.service.registerPlugin(PLUGIN, activation)).toBe(
			false,
		);

		// A poll suspends on its lookup, then a secret change suspends on its own.
		await vi.advanceTimersByTimeAsync(1);
		const secretChange = harness.emitSecretChange();

		// stop() drains the active poll, so the pending map is still live when
		// the secret-change lookup resolves — activation must still be refused.
		const stopping = harness.service.stop();
		releaseChange?.([]);
		await vi.advanceTimersByTimeAsync(0);
		expect(activation).not.toHaveBeenCalled();

		releasePoll?.(["TOKEN"]);
		await secretChange;
		await stopping;

		expect(activation).not.toHaveBeenCalled();
	});

	it("does not activate an unregistered plugin after its poll lookup resolves", async () => {
		let releaseLookup: ((missing: string[]) => void) | undefined;
		const lookupGate = new Promise<string[]>((resolve) => {
			releaseLookup = resolve;
		});
		const activation = vi.fn(async () => undefined);
		const harness = await createHarness(() => lookupGate);
		activeService = harness.service;
		expect(await harness.service.registerPlugin(PLUGIN, activation)).toBe(
			false,
		);
		await vi.advanceTimersByTimeAsync(1);

		expect(harness.service.unregisterPlugin(PLUGIN.name)).toBe(true);
		releaseLookup?.([]);
		await vi.advanceTimersByTimeAsync(1);
		await harness.service.stop();

		expect(activation).not.toHaveBeenCalled();
	});

	it("refuses registration requested after stop began", async () => {
		let releaseLookup: ((missing: string[]) => void) | undefined;
		const lookupGate = new Promise<string[]>((resolve) => {
			releaseLookup = resolve;
		});
		const activation = vi.fn(async () => undefined);
		const harness = await createHarness(() => lookupGate);
		activeService = harness.service;
		expect(await harness.service.registerPlugin(PLUGIN, activation)).toBe(
			false,
		);
		await vi.advanceTimersByTimeAsync(1);

		// stop() begins while the poll lookup is suspended.
		const stopping = harness.service.stop();
		releaseLookup?.(["TOKEN"]);
		await stopping;
		await vi.advanceTimersByTimeAsync(0);

		// Any registration after stop must be refused, including the
		// secretless immediate-activation path (which on the unfixed tree
		// activates the plugin synchronously inside registerPlugin).
		const secretlessPlugin: PluginWithSecrets = {
			name: "secretless-stop-probe",
			description: "Registers with no secret requirements.",
		};
		expect(
			await harness.service.registerPlugin(secretlessPlugin, activation),
		).toBe(false);
		expect(activation).not.toHaveBeenCalled();
	});

	it("refuses registration whose requirements lookup resolves after stop", async () => {
		let releaseRequirements:
			| ((status: {
					ready: boolean;
					missingRequired: string[];
					missingOptional: string[];
					invalid: string[];
			  }) => void)
			| undefined;
		const requirementsGate = new Promise<{
			ready: boolean;
			missingRequired: string[];
			missingOptional: string[];
			invalid: string[];
		}>((resolve) => {
			releaseRequirements = resolve;
		});
		const activation = vi.fn(async () => undefined);
		const harness = await createHarness(
			async () => [],
			async () => requirementsGate,
		);
		activeService = harness.service;

		// Registration suspends inside checkPluginRequirements.
		const registration = harness.service.registerPlugin(PLUGIN, activation);

		// stop() completes before the requirements lookup resolves.
		const stopping = harness.service.stop();
		await vi.advanceTimersByTimeAsync(0);
		releaseRequirements?.({
			ready: true,
			missingRequired: [],
			missingOptional: [],
			invalid: [],
		});
		expect(await registration).toBe(false);
		await stopping;

		expect(activation).not.toHaveBeenCalled();
		expect(harness.service.isPending(PLUGIN.name)).toBe(false);
	});

	it("stop drains an activation that already started without re-entering it", async () => {
		let releaseActivation: (() => void) | undefined;
		const activationGate = new Promise<void>((resolve) => {
			releaseActivation = resolve;
		});
		let activationEntries = 0;
		const activation = vi.fn(async () => {
			activationEntries += 1;
			await activationGate;
		});
		const harness = await createHarness(async () => []);
		activeService = harness.service;
		expect(await harness.service.registerPlugin(PLUGIN, activation)).toBe(
			false,
		);

		// The activation callback is entered and suspended in flight.
		await vi.advanceTimersByTimeAsync(1);
		expect(activation).toHaveBeenCalledTimes(1);

		// stop() must not settle while the in-flight activation is still
		// pending — a shutdown that returns early would pass the flush below.
		let stopped = false;
		const stopping = harness.service.stop().then(() => {
			stopped = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(stopped).toBe(false);

		releaseActivation?.();
		await stopping;
		await vi.advanceTimersByTimeAsync(0);

		expect(activationEntries).toBe(1);
		expect(harness.service.isPending(PLUGIN.name)).toBe(false);
		expect(harness.service.isActivated(PLUGIN.name)).toBe(false);
	});
});
