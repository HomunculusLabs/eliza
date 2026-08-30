/**
 * Contract tests for the SETTINGS provider's consumer-visible rendering
 * surface: secret masking outside the DM setup flow, decrypted plaintext
 * inside it, explicit not-set rendering, and the J4 unavailable state on
 * read failures. The prior surrogate suite was removed with the prompt-cap
 * cleanup; this suite is its behavior owner, driving the real provider with
 * real salt/unsalt crypto over a deterministic runtime stub.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearSaltCache,
	getSalt,
	saltWorldSettings,
} from "../../../settings.ts";
import type {
	IAgentRuntime,
	Memory,
	Room,
	State,
	World,
	WorldSettings,
} from "../../../types/index.ts";
import { ChannelType } from "../../../types/index.ts";
import { settingsProvider } from "./settings.ts";

const ROOM_ID = "00000000-0000-0000-0000-000000000001" as Memory["roomId"];
const ENTITY_ID = "00000000-0000-0000-0000-0000000000ee";
const WORLD_ID = "00000000-0000-0000-0000-0000000000aa";
const SERVER_ID = "00000000-0000-0000-0000-0000000000cc";
const SECRET_PLAINTEXT = "super-secret-api-key-30013";
const TEST_SALT = "test-salt-30013-deterministic";

/**
 * Flat WorldSettings fixture: a salted secret, a plaintext non-secret, and a
 * null-valued required setting. `dependsOn` is mandatory — the provider's
 * isSetting() guard filters rows without it.
 */
function unsaltedFixture(): WorldSettings {
	return {
		apiToken: {
			name: "API Token",
			description: "Provider API token",
			usageDescription: "Used for model calls",
			required: true,
			secret: true,
			value: SECRET_PLAINTEXT,
			dependsOn: [],
		},
		displayName: {
			name: "Display Name",
			description: "Public display name",
			usageDescription: "Shown to users",
			required: false,
			secret: false,
			value: "Eliza Test World",
			dependsOn: [],
		},
		webhookUrl: {
			name: "Webhook URL",
			description: "Inbound webhook",
			usageDescription: "Receives events",
			required: true,
			secret: false,
			value: null,
			dependsOn: [],
		},
	};
}

interface RuntimeLog {
	updatedWorlds: World[];
	reportedErrors: Array<{ scope: string; error: unknown; context: unknown }>;
}

function runtimeWith(
	room: Room | null,
	worlds: World[],
	getWorldImpl?: (worldId: string) => Promise<World | null>,
): { runtime: IAgentRuntime; log: RuntimeLog } {
	const log: RuntimeLog = { updatedWorlds: [], reportedErrors: [] };
	const runtime = {
		agentId: "00000000-0000-0000-0000-0000000000ff",
		character: { name: "TestAgent" },
		getRoom: async () => room,
		getAllWorlds: async () => worlds,
		getWorld:
			getWorldImpl ??
			(async (worldId: string) =>
				(worlds.find((w) => w.id === worldId) as World | null) ?? null),
		updateWorld: async (world: World) => {
			log.updatedWorlds.push(world);
		},
		reportError: (scope: string, error: unknown, context?: unknown) => {
			log.reportedErrors.push({ scope, error, context });
		},
	} as unknown as IAgentRuntime;
	return { runtime, log };
}

function groupRoom(): Room {
	return {
		id: ROOM_ID,
		source: "test",
		type: ChannelType.GROUP,
		worldId: WORLD_ID,
	} as Room;
}

function dmRoom(): Room {
	// The no-worldId skip fires before the setup branch, so a DM still needs a
	// worldId even though setup resolves the world through owner lookup.
	return {
		id: ROOM_ID,
		source: "test",
		type: ChannelType.DM,
		worldId: WORLD_ID,
	} as Room;
}

function worldWithSettings(settings: WorldSettings): World {
	return {
		id: WORLD_ID,
		agentId: "00000000-0000-0000-0000-0000000000ff",
		messageServerId: SERVER_ID as World["messageServerId"],
		metadata: {
			ownership: { ownerId: ENTITY_ID },
			settings,
		},
	} as unknown as World;
}

function message(): Memory {
	return { roomId: ROOM_ID, entityId: ENTITY_ID } as Memory;
}

const state = {} as State;

describe("SETTINGS provider contracts", () => {
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of [
			"SECRET_SALT",
			"NODE_ENV",
			"ELIZA_ALLOW_DEFAULT_SECRET_SALT",
		]) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		process.env.SECRET_SALT = TEST_SALT;
		clearSaltCache();
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		clearSaltCache();
	});

	it("encrypts the secret fixture with real crypto (fixture self-check)", () => {
		const salted = saltWorldSettings(unsaltedFixture(), TEST_SALT);
		const stored = salted.apiToken as { value?: string };
		expect(String(stored.value)).not.toContain(SECRET_PLAINTEXT);
		expect(String(stored.value).startsWith("v2:")).toBe(true);
		expect(getSalt()).toBe(TEST_SALT);
	});

	it("masks secrets and renders real values outside setup (non-DM room)", async () => {
		const salted = saltWorldSettings(unsaltedFixture(), TEST_SALT);
		const world = worldWithSettings(salted);
		const { runtime, log } = runtimeWith(groupRoom(), [world]);

		const result = await settingsProvider.get(runtime, message(), state);

		expect(result.text).toContain("Current Configuration");
		// The mask, never the plaintext, crosses the non-setup compose boundary.
		expect(result.text).toContain("****************");
		expect(result.text).not.toContain(SECRET_PLAINTEXT);
		// Non-secret values render; null renders as an explicit not-set state.
		expect(result.text).toContain("Eliza Test World");
		expect(result.text).toContain("Not set");
		expect(log.reportedErrors).toHaveLength(0);
		expect(log.updatedWorlds).toHaveLength(0);
	});

	it("renders decrypted plaintext inside the DM setup flow without re-initializing", async () => {
		const salted = saltWorldSettings(unsaltedFixture(), TEST_SALT);
		const world = worldWithSettings(salted);
		const { runtime, log } = runtimeWith(dmRoom(), [world]);

		const result = await settingsProvider.get(runtime, message(), state);

		// Setup mode surfaces the decrypted secret so the owner can verify it.
		expect(result.text).toContain(SECRET_PLAINTEXT);
		expect(result.text).not.toContain("****************");
		// The world already carries settings: the initialization write must not fire.
		expect(log.updatedWorlds).toHaveLength(0);
		expect(log.reportedErrors).toHaveLength(0);
	});

	it("initializes an empty settings block on the owner's world during DM setup", async () => {
		const bareWorld = {
			id: WORLD_ID,
			agentId: "00000000-0000-0000-0000-0000000000ff",
			messageServerId: SERVER_ID as World["messageServerId"],
			metadata: {
				ownership: { ownerId: ENTITY_ID },
				description: "sentinel-unrelated-metadata",
			},
		} as unknown as World;
		// A competing world owned by someone else must never be selected or
		// written, even when it sorts first in the owner-lookup result.
		const nonOwnerWorld = {
			id: "00000000-0000-0000-0000-0000000000dd",
			agentId: "00000000-0000-0000-0000-0000000000ff",
			messageServerId: SERVER_ID as World["messageServerId"],
			metadata: { ownership: { ownerId: "someone-else" } },
		} as unknown as World;
		const { runtime, log } = runtimeWith(dmRoom(), [nonOwnerWorld, bareWorld]);

		const result = await settingsProvider.get(runtime, message(), state);

		// The provider persists { settings: {} } onto the first owner world, then
		// renders the empty setup checklist — a designed state, not unavailable.
		expect(log.updatedWorlds).toHaveLength(1);
		const written = log.updatedWorlds[0];
		expect(written.id).toBe(WORLD_ID);
		expect(written.metadata?.settings).toEqual({ settings: {} });
		expect(written.metadata?.ownership).toEqual({ ownerId: ENTITY_ID });
		// Unrelated metadata keys survive the initialization write.
		expect(written.metadata?.description).toBe("sentinel-unrelated-metadata");
		expect(result.text).toContain("All required settings have been configured");
		expect(result.text).not.toContain("temporarily unavailable");
		expect(log.reportedErrors).toHaveLength(0);
	});

	it("returns the J4 unavailable state when a read collaborator throws", async () => {
		const failure = new Error("world store exploded");
		const { runtime, log } = runtimeWith(groupRoom(), [], async () => {
			throw failure;
		});

		const result = await settingsProvider.get(runtime, message(), state);

		// Read failure becomes a visibly distinct unavailable state — never a
		// throw into the compose, and never a healthy-looking value.
		expect(result.text).toBe("Configuration is temporarily unavailable.");
		expect(result.values?.settings).toBe(
			"Configuration is temporarily unavailable.",
		);
		expect(result.data).toEqual({
			available: false,
			error: "world store exploded",
		});
		expect(log.reportedErrors).toHaveLength(1);
		expect(log.reportedErrors[0]?.scope).toBe("SettingsProvider.get");
		expect(log.reportedErrors[0]?.error).toBe(failure);
		expect(log.reportedErrors[0]?.context).toEqual({ roomId: ROOM_ID });
	});

	it("returns the J4 state for the whole provider when the stored salt no longer matches", async () => {
		// Salt rotation / ephemeral-salt restart: GCM auth failure on the stored
		// ciphertext is a data-state read failure — the provider degrades to the
		// unavailable DTO rather than rendering ciphertext as a setting value.
		const wrongSalt = saltWorldSettings(unsaltedFixture(), "a-different-salt");
		const world = worldWithSettings(wrongSalt);
		const { runtime, log } = runtimeWith(dmRoom(), [world]);

		const result = await settingsProvider.get(runtime, message(), state);

		expect(result.text).toBe("Configuration is temporarily unavailable.");
		expect(result.data).toMatchObject({ available: false });
		expect(log.reportedErrors).toHaveLength(1);
		// The ciphertext must never leak into the rendered output.
		const stored = wrongSalt.apiToken as { value?: string };
		expect(result.text).not.toContain(String(stored.value));
	});

	it("renders Not set — never the mask — for an unset secret, pinning branch order", async () => {
		const fixture = unsaltedFixture();
		// A required secret that was never configured.
		fixture.unsetSecret = {
			name: "Unset Secret",
			description: "Never configured",
			usageDescription: "N/A",
			required: true,
			secret: true,
			value: null,
			dependsOn: [],
		};
		const world = worldWithSettings(saltWorldSettings(fixture, TEST_SALT));
		const { runtime } = runtimeWith(groupRoom(), [world]);

		const result = await settingsProvider.get(runtime, message(), state);

		const rendered = result.text ?? "";
		expect(rendered).toContain("Not set");
		// value === null is checked before the secret branch: exactly one mask
		// (the configured apiToken), and no mask for the unset secret.
		expect(rendered.split("****************").length - 1).toBe(1);
	});

	it("hides settings whose visibleIf predicate excludes them", async () => {
		// visibleIf receives the normalized settings record — for the flat
		// shape that is the flat entries themselves, so a real dependency
		// predicate (visible only while its dependency is unset) works.
		const fixture = unsaltedFixture();
		fixture.hiddenOption = {
			name: "Hidden Option",
			description: "Conditional setting",
			usageDescription: "Only for dependency-driven visibility",
			required: false,
			secret: false,
			value: "should-not-render",
			dependsOn: [],
			visibleIf: (
				settings: Record<string, { value: string | boolean | null }>,
			) => settings.apiToken?.value === null,
		};
		const world = worldWithSettings(saltWorldSettings(fixture, TEST_SALT));
		const { runtime } = runtimeWith(groupRoom(), [world]);

		const result = await settingsProvider.get(runtime, message(), state);

		expect(result.text).toContain("Current Configuration");
		// apiToken is configured, so the dependency gate hides the option.
		expect(result.text).not.toContain("should-not-render");
		expect(result.text).not.toContain("Hidden Option");

		// Control: with the dependency unset, the option becomes visible.
		if (fixture.apiToken) fixture.apiToken.value = null;
		fixture.hiddenOption.value = "now-visible";
		const world2 = worldWithSettings(saltWorldSettings(fixture, TEST_SALT));
		const { runtime: runtime2 } = runtimeWith(groupRoom(), [world2]);
		const result2 = await settingsProvider.get(runtime2, message(), state);
		expect(result2.text).toContain("now-visible");
	});

	it("keeps decrypted plaintext out of the values channel outside setup", async () => {
		// The mask governs the model-facing text; this pins the same
		// confidentiality expectation on the values channel so a mutation that
		// masks text while leaking plaintext through values goes red.
		const world = worldWithSettings(
			saltWorldSettings(unsaltedFixture(), TEST_SALT),
		);
		const { runtime } = runtimeWith(groupRoom(), [world]);

		const result = await settingsProvider.get(runtime, message(), state);

		expect(JSON.stringify(result.values)).not.toContain(SECRET_PLAINTEXT);
	});

	it("masks secret values in the structured data payload outside setup", async () => {
		// The data payload flows into composed state and action trajectory
		// state snapshots, which are not secret-redacted — decrypted plaintext
		// must not survive there (issue #30013's trajectory-leak risk).
		const world = worldWithSettings(
			saltWorldSettings(unsaltedFixture(), TEST_SALT),
		);
		const { runtime } = runtimeWith(groupRoom(), [world]);

		const result = await settingsProvider.get(runtime, message(), state);

		expect(JSON.stringify(result.data)).not.toContain(SECRET_PLAINTEXT);
		const settings = (result.data as { settings?: WorldSettings }).settings;
		// The mask replaces the value; structure and neighbors survive.
		expect(settings?.apiToken).toMatchObject({ value: "****************" });
		expect(settings?.displayName).toMatchObject({ value: "Eliza Test World" });
		expect(settings?.webhookUrl).toMatchObject({ value: null });
		// Inside setup the owner-verifying plaintext view is the point.
		const dmRuntime = runtimeWith(dmRoom(), [
			worldWithSettings(saltWorldSettings(unsaltedFixture(), TEST_SALT)),
		]).runtime;
		const dmResult = await settingsProvider.get(dmRuntime, message(), state);
		expect(JSON.stringify(dmResult.data)).toContain(SECRET_PLAINTEXT);
	});

	it("renders a populated wrapped settings registry, masking secrets outside setup", async () => {
		// SETTINGS-set (packages/agent settings-actions) persists the wrapped
		// { settings: Record<string, Setting> } shape; the renderer must read
		// the registry, not iterate the wrapper object.
		const wrapped: WorldSettings = {
			settings: {
				...unsaltedFixture(),
			} as Record<string, import("../../../types/index.ts").Setting>,
		};
		const world = worldWithSettings(saltWorldSettings(wrapped, TEST_SALT));
		const { runtime } = runtimeWith(groupRoom(), [world]);

		const result = await settingsProvider.get(runtime, message(), state);

		const rendered = result.text ?? "";
		expect(rendered).toContain("Current Configuration");
		expect(rendered).toContain("Eliza Test World");
		expect(rendered).toContain("Not set");
		expect(rendered).toContain("****************");
		expect(rendered).not.toContain(SECRET_PLAINTEXT);
	});

	it("masks secrets in both shapes of a mixed flat+wrapped payload", async () => {
		// WorldSettings permits flat entries and a settings registry side by
		// side; a secret living in either must not survive the payload.
		const flatSecret: WorldSettings = {
			...unsaltedFixture(),
		};
		const mixed: WorldSettings = {
			...flatSecret,
			settings: {
				registryToken: {
					name: "Registry Token",
					description: "Secret inside the wrapped registry",
					usageDescription: "N/A",
					required: false,
					secret: true,
					value: "registry-secret-plaintext",
					dependsOn: [],
				},
			} as Record<string, import("../../../types/index.ts").Setting>,
		};
		const world = worldWithSettings(saltWorldSettings(mixed, TEST_SALT));
		const { runtime } = runtimeWith(groupRoom(), [world]);

		const result = await settingsProvider.get(runtime, message(), state);

		expect(JSON.stringify(result.data)).not.toContain(SECRET_PLAINTEXT);
		expect(JSON.stringify(result.data)).not.toContain(
			"registry-secret-plaintext",
		);
	});

	it("translates a missing room world into the J4 state via the deliberate throw", async () => {
		// getWorld returning null triggers the provider's own
		// `throw new Error("No world found for room ...")`, which the J4 catch
		// translates — the consumer still sees the unavailable DTO, not a throw.
		const world = worldWithSettings(
			saltWorldSettings(unsaltedFixture(), TEST_SALT),
		);
		const { runtime, log } = runtimeWith(
			groupRoom(),
			[world],
			async () => null,
		);

		const result = await settingsProvider.get(runtime, message(), state);

		expect(result.text).toBe("Configuration is temporarily unavailable.");
		expect(result.data).toMatchObject({
			available: false,
			error: `No world found for room ${WORLD_ID}`,
		});
		expect(log.reportedErrors).toHaveLength(1);
	});

	it("does not re-initialize settings when the owner world already carries them", async () => {
		const initialized = worldWithSettings({ settings: {} });
		const { runtime, log } = runtimeWith(dmRoom(), [initialized]);

		const result = await settingsProvider.get(runtime, message(), state);

		// The find(metadata.settings !== undefined) short-circuit makes the
		// initialization write idempotent across consecutive provider runs.
		expect(log.updatedWorlds).toHaveLength(0);
		expect(result.text).not.toContain("temporarily unavailable");
	});

	it("returns an explicit error boundary when the room is missing", async () => {
		const { runtime, log } = runtimeWith(null, []);

		const result = await settingsProvider.get(runtime, message(), state);

		expect(result.text).toBe("Error: Room not found");
		expect(log.reportedErrors).toHaveLength(0);
	});

	it("skips with a designed-skip message when the room has no world", async () => {
		const room = {
			id: ROOM_ID,
			source: "test",
			type: ChannelType.GROUP,
		} as Room;
		const { runtime, log } = runtimeWith(room, []);

		const result = await settingsProvider.get(runtime, message(), state);

		expect(result.text).toContain("settings provider will be skipped");
		expect(log.reportedErrors).toHaveLength(0);
	});
});
