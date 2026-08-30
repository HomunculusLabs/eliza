/**
 * Pins the manage-server authorization gate contract at its owning boundary:
 * exact durable world/room binding (agent id, message server id, and the
 * four-way room filter), fresh verified-identity-cluster resolution after
 * turn-memo invalidation, ADMIN+ membership in the destination world, and the
 * typed deny envelope. Deterministic mock runtime against the real gate
 * function — no DB, no model, no connectors.
 */
import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors.ts";
import { getVerifiedRelatedEntityIds } from "../identity-clusters.ts";
import { runWithTrajectoryContext } from "../trajectory-context.ts";
import type { IAgentRuntime, UUID } from "../types/index.ts";
import { stringToUuid } from "../utils.ts";
import { authorizeManageServerDestination } from "./manage-server-authorization.ts";

const AGENT_ID = stringToUuid("msa-agent") as UUID;
const OTHER_AGENT_ID = stringToUuid("msa-other-agent") as UUID;
const REQUESTER_ID = stringToUuid("msa-requester") as UUID;
const LINKED_ALPHA = stringToUuid("msa-linked-alpha") as UUID;
const LINKED_BETA = stringToUuid("msa-linked-beta") as UUID;
const WORLD_ID = stringToUuid("msa-world") as UUID;
const ROOM_ID = stringToUuid("msa-room") as UUID;
const SECOND_ROOM_ID = stringToUuid("msa-room-2") as UUID;
const FOREIGN_ROOM_ID = stringToUuid("msa-foreign-room") as UUID;

const SERVER_ID = "223456789012345678";
const MESSAGE_SERVER_ID = stringToUuid(SERVER_ID) as UUID;
const OTHER_MESSAGE_SERVER_ID = stringToUuid("999999999999999999") as UUID;

type Destination = Parameters<typeof authorizeManageServerDestination>[2];

function destination(): Destination {
	return {
		source: "discord",
		accountId: "primary",
		serverId: SERVER_ID,
		messageServerId: MESSAGE_SERVER_ID,
		destinationWorldId: WORLD_ID,
		target: { source: "discord", accountId: "primary", serverId: SERVER_ID },
	};
}

interface HarnessOptions {
	/** world.agentId for the destination world (defaults to the runtime agent). */
	worldAgentId?: UUID;
	/** world.messageServerId (defaults to the destination's). */
	worldMessageServerId?: UUID;
	/** Persisted rooms returned by runtime.getRooms for the destination world. */
	rooms?: Array<Record<string, unknown>>;
	/** Verified cluster answers, one per resolver call (defaults to [[]]). */
	clusterAnswers?: Array<Array<UUID>>;
	/** Roles metadata on the destination world. */
	roles?: Record<string, string>;
	/** Room membership per entity for getRoomsForParticipant. */
	roomMembership?: Record<string, UUID[]>;
	/** Rooms the agent participates in (defaults to ROOM_ID). */
	agentRooms?: UUID[];
	/** When set, getWorld resolves the destination world to null. */
	missingWorld?: boolean;
}

function harness(options: HarnessOptions = {}) {
	const clusterAnswers = options.clusterAnswers ?? [[]];
	let resolverCalls = 0;
	const resolver = {
		async getVerifiedMemberEntityIds(): Promise<UUID[]> {
			const answer = clusterAnswers[resolverCalls] ?? [];
			resolverCalls += 1;
			return answer;
		},
	};
	const worldAgentId = options.worldAgentId ?? AGENT_ID;
	const worldMessageServerId =
		options.worldMessageServerId ?? MESSAGE_SERVER_ID;
	const rooms = options.rooms ?? [
		{
			id: ROOM_ID,
			worldId: WORLD_ID,
			source: "discord",
			serverId: SERVER_ID,
			messageServerId: MESSAGE_SERVER_ID,
		},
	];
	const roomMembership = options.roomMembership ?? {};
	const agentRooms = options.agentRooms ?? [ROOM_ID];
	const runtime = {
		agentId: AGENT_ID,
		getSetting: () => undefined,
		reportError: () => undefined,
		getService: (serviceType: string) =>
			serviceType === "relationships" ? resolver : null,
		getWorld: async (worldId: UUID) =>
			!options.missingWorld && worldId === WORLD_ID
				? {
						id: WORLD_ID,
						agentId: worldAgentId,
						messageServerId: worldMessageServerId,
						metadata: {
							roles: options.roles ?? {},
							roleSources: Object.fromEntries(
								Object.keys(options.roles ?? {}).map((id) => [id, "manual"]),
							),
						},
					}
				: null,
		getRooms: async (worldId: UUID) =>
			worldId === WORLD_ID ? (rooms as never) : [],
		getRoomsForParticipant: async (entityId: UUID): Promise<UUID[]> =>
			entityId === AGENT_ID ? agentRooms : (roomMembership[entityId] ?? []),
	} as unknown as IAgentRuntime;
	return { runtime, resolver: () => resolverCalls };
}

function inTurn<T>(work: () => Promise<T>): Promise<T> {
	return runWithTrajectoryContext({ turnMemo: new Map() }, work) as Promise<T>;
}

async function denyCode(promise: Promise<unknown>): Promise<ElizaError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(ElizaError);
		return error as ElizaError;
	}
	throw new Error("expected the gate to deny, but it resolved");
}

describe("authorizeManageServerDestination binding exactness", () => {
	it("denies a world bound to a different agent with UNBOUND", async () => {
		const { runtime } = harness({
			worldAgentId: OTHER_AGENT_ID,
			roles: { [REQUESTER_ID]: "ADMIN" },
		});
		const error = await denyCode(
			authorizeManageServerDestination(runtime, REQUESTER_ID, destination()),
		);
		expect(error.code).toBe("MANAGE_SERVER_DESTINATION_UNBOUND");
		expect(error.context).toMatchObject({
			source: "discord",
			serverId: SERVER_ID,
			destinationWorldId: WORLD_ID,
		});
	});

	it("denies a world whose message server differs from the destination", async () => {
		const { runtime } = harness({
			worldMessageServerId: OTHER_MESSAGE_SERVER_ID,
			roles: { [REQUESTER_ID]: "ADMIN" },
		});
		const error = await denyCode(
			authorizeManageServerDestination(runtime, REQUESTER_ID, destination()),
		);
		expect(error.code).toBe("MANAGE_SERVER_DESTINATION_UNBOUND");
	});

	it("does not count rooms from the same world but a different server binding", async () => {
		const { runtime } = harness({
			roles: { [REQUESTER_ID]: "ADMIN" },
			// Same world and source, but neither room matches the exact
			// (serverId, messageServerId) binding of the destination.
			rooms: [
				{
					id: ROOM_ID,
					worldId: WORLD_ID,
					source: "discord",
					serverId: "111111111111111111",
					messageServerId: MESSAGE_SERVER_ID,
				},
				{
					id: FOREIGN_ROOM_ID,
					worldId: WORLD_ID,
					source: "discord",
					serverId: SERVER_ID,
					messageServerId: OTHER_MESSAGE_SERVER_ID,
				},
			],
		});
		const error = await denyCode(
			authorizeManageServerDestination(runtime, REQUESTER_ID, destination()),
		);
		expect(error.code).toBe("MANAGE_SERVER_DESTINATION_UNBOUND");
	});

	it("does not count rooms persisted under a different world id", async () => {
		const { runtime } = harness({
			roles: { [REQUESTER_ID]: "ADMIN" },
			// Exact server binding, but the room row belongs to another world.
			rooms: [
				{
					id: ROOM_ID,
					worldId: stringToUuid("msa-other-world") as UUID,
					source: "discord",
					serverId: SERVER_ID,
					messageServerId: MESSAGE_SERVER_ID,
				},
			],
		});
		const error = await denyCode(
			authorizeManageServerDestination(runtime, REQUESTER_ID, destination()),
		);
		expect(error.code).toBe("MANAGE_SERVER_DESTINATION_UNBOUND");
	});

	it("does not count rooms persisted under a different source", async () => {
		const { runtime } = harness({
			roles: { [REQUESTER_ID]: "ADMIN" },
			// Exact world and server binding, but the room row belongs to
			// another connector source.
			rooms: [
				{
					id: ROOM_ID,
					worldId: WORLD_ID,
					source: "telegram",
					serverId: SERVER_ID,
					messageServerId: MESSAGE_SERVER_ID,
				},
			],
		});
		const error = await denyCode(
			authorizeManageServerDestination(runtime, REQUESTER_ID, destination()),
		);
		expect(error.code).toBe("MANAGE_SERVER_DESTINATION_UNBOUND");
	});

	it("denies with UNBOUND when the destination world is missing entirely", async () => {
		const { runtime } = harness({
			missingWorld: true,
			roles: { [REQUESTER_ID]: "ADMIN" },
		});
		const error = await denyCode(
			authorizeManageServerDestination(runtime, REQUESTER_ID, destination()),
		);
		expect(error.code).toBe("MANAGE_SERVER_DESTINATION_UNBOUND");
	});
});

describe("authorizeManageServerDestination identity freshness", () => {
	it("re-queries the verified cluster after invalidating the turn memo, so a revoked link cannot authorize", async () => {
		// Call 1 (memo priming): ALPHA is still a verified linked identity and
		// is ADMIN+member of the destination world. Call 2 (inside the gate,
		// after invalidation): the link was revoked and the cluster is empty.
		const { runtime, resolver } = harness({
			clusterAnswers: [[LINKED_ALPHA], []],
			roles: { [LINKED_ALPHA]: "ADMIN" },
			roomMembership: { [LINKED_ALPHA]: [ROOM_ID] },
		});

		const authorization = await inTurn(async () => {
			// Prime the turn memo with the pre-revocation cluster — this is the
			// stale snapshot the gate must not trust.
			await getVerifiedRelatedEntityIds(runtime, REQUESTER_ID);
			return authorizeManageServerDestination(
				runtime,
				REQUESTER_ID,
				destination(),
			);
		}).catch((error: unknown) => error);

		expect(authorization).toBeInstanceOf(ElizaError);
		expect((authorization as ElizaError).code).toBe(
			"MANAGE_SERVER_DESTINATION_NOT_AUTHORIZED",
		);
		// Exactly two resolver calls prove the gate invalidated and re-queried
		// rather than reusing the primed memo (one call would mean stale reuse).
		expect(resolver()).toBe(2);
	});

	it("authorizes through a linked identity that is ADMIN and shares a binding room", async () => {
		const { runtime, resolver } = harness({
			clusterAnswers: [[LINKED_ALPHA]],
			roles: { [LINKED_ALPHA]: "ADMIN" },
			roomMembership: { [LINKED_ALPHA]: [ROOM_ID] },
		});
		const authorization = await inTurn(() =>
			authorizeManageServerDestination(runtime, REQUESTER_ID, destination()),
		);
		expect(resolver()).toBe(1);
		expect(authorization).toMatchObject({
			requesterEntityId: REQUESTER_ID,
			authorizedEntityId: LINKED_ALPHA,
			role: "ADMIN",
			bindingRoomIds: [ROOM_ID],
			destinationWorldId: WORLD_ID,
			serverId: SERVER_ID,
		});
	});

	it("promotes an OWNER member and reports the OWNER role", async () => {
		const { runtime } = harness({
			clusterAnswers: [[LINKED_ALPHA]],
			roles: { [LINKED_ALPHA]: "OWNER" },
			roomMembership: { [LINKED_ALPHA]: [ROOM_ID] },
		});
		const authorization = await inTurn(() =>
			authorizeManageServerDestination(runtime, REQUESTER_ID, destination()),
		);
		expect(authorization.role).toBe("OWNER");
	});

	it("denies a linked identity that is a member but not ADMIN", async () => {
		const { runtime } = harness({
			clusterAnswers: [[LINKED_BETA]],
			roles: { [LINKED_BETA]: "USER" },
			roomMembership: { [LINKED_BETA]: [ROOM_ID] },
		});
		const error = await denyCode(
			authorizeManageServerDestination(runtime, REQUESTER_ID, destination()),
		);
		expect(error.code).toBe("MANAGE_SERVER_DESTINATION_NOT_AUTHORIZED");
	});

	it("denies a linked ADMIN whose rooms do not intersect the binding", async () => {
		const { runtime } = harness({
			clusterAnswers: [[LINKED_ALPHA]],
			roles: { [LINKED_ALPHA]: "ADMIN" },
			roomMembership: { [LINKED_ALPHA]: [FOREIGN_ROOM_ID] },
		});
		const error = await denyCode(
			authorizeManageServerDestination(runtime, REQUESTER_ID, destination()),
		);
		expect(error.code).toBe("MANAGE_SERVER_DESTINATION_NOT_AUTHORIZED");
	});

	it("keeps only rooms the agent itself shares, dropping requester-only binding rooms", async () => {
		// The requester and the destination share two exact binding rooms, but
		// the agent participates in only the first — the agent-side
		// intersection must exclude the second.
		const { runtime } = harness({
			clusterAnswers: [[REQUESTER_ID]],
			roles: { [REQUESTER_ID]: "ADMIN" },
			rooms: [
				{
					id: ROOM_ID,
					worldId: WORLD_ID,
					source: "discord",
					serverId: SERVER_ID,
					messageServerId: MESSAGE_SERVER_ID,
				},
				{
					id: SECOND_ROOM_ID,
					worldId: WORLD_ID,
					source: "discord",
					serverId: SERVER_ID,
					messageServerId: MESSAGE_SERVER_ID,
				},
			],
			roomMembership: { [REQUESTER_ID]: [ROOM_ID, SECOND_ROOM_ID] },
			agentRooms: [ROOM_ID],
		});
		const authorization = await inTurn(() =>
			authorizeManageServerDestination(runtime, REQUESTER_ID, destination()),
		);
		expect(authorization.bindingRoomIds).toEqual([ROOM_ID]);
	});

	it("keeps scanning the cluster past a member with shared rooms but insufficient role", async () => {
		// The first cluster member shares a binding room but is only USER;
		// the loop must continue to the second member, an ADMIN who also
		// shares a room, and authorize through them.
		const { runtime } = harness({
			clusterAnswers: [[REQUESTER_ID, LINKED_ALPHA]],
			roles: { [REQUESTER_ID]: "USER", [LINKED_ALPHA]: "ADMIN" },
			roomMembership: {
				[REQUESTER_ID]: [ROOM_ID],
				[LINKED_ALPHA]: [ROOM_ID],
			},
		});
		const authorization = await inTurn(() =>
			authorizeManageServerDestination(runtime, REQUESTER_ID, destination()),
		);
		expect(authorization.authorizedEntityId).toBe(LINKED_ALPHA);
		expect(authorization.role).toBe("ADMIN");
	});
});
