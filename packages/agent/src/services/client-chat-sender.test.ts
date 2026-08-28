/**
 * Tests for registerClientChatSendHandler — the wiring that relays the agent's
 * outbound messages back into dashboard / REST conversations. Covers which relay
 * sources get a send handler, delivery into the matching conversation (including
 * an unknown dashboard-origin source routed via the default fallback), not
 * hijacking a real connector's own handler, cross-conversation safety, and
 * single-owner swarm delivery. Most cases use a deterministic state stand-in;
 * transport ownership runs through AgentRuntime and InMemoryDatabaseAdapter.
 */
import crypto from "node:crypto";
import {
  AgentRuntime,
  ChannelType,
  type Character,
  type Content,
  type IAgentRuntime,
  InMemoryDatabaseAdapter,
  type Memory,
  type SendHandlerFunction,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleSwarmSynthesis } from "../api/server-helpers-swarm.ts";
import type { ConversationMeta, ServerState } from "../api/server-types.ts";
import { registerClientChatSendHandler } from "./client-chat-sender.ts";

/** A minimal AgentRuntime stand-in that mirrors the real send-handler routing.
 * Public handlers are connector capabilities; internal handlers remain
 * addressable by runtime relays without appearing in connector discovery. */
function makeRuntime() {
  const handlers = new Map<string, SendHandlerFunction>();
  const connectors: Array<{ source: string }> = [];
  const created: Memory[] = [];
  const runtime = {
    agentId: crypto.randomUUID() as UUID,
    registerSendHandler(source: string, handler: SendHandlerFunction) {
      handlers.set(source, handler);
      connectors.push({ source });
    },
    registerInternalSendHandler(source: string, handler: SendHandlerFunction) {
      handlers.set(source, handler);
    },
    getMessageConnectors() {
      return connectors;
    },
    createMemory: vi.fn(async (memory: Memory) => {
      created.push(memory);
      return memory.id as UUID;
    }),
    async sendMessageToTarget(
      target: TargetInfo,
      content: Content,
    ): Promise<Memory | undefined> {
      const source =
        typeof target.source === "string" ? target.source.trim() : "";
      const handler = handlers.get(source);
      if (!handler) {
        throw new Error(`No send handler registered for source: ${source}`);
      }
      return (await handler(
        runtime as unknown as IAgentRuntime,
        target,
        content,
      )) as Memory | undefined;
    },
  };
  return { runtime, handlers, connectors, created };
}

function makeState(
  conversations: ConversationMeta[],
  activeConversationId: string | null = null,
) {
  const broadcastWs = vi.fn();
  const map = new Map<string, ConversationMeta>();
  for (const conv of conversations) map.set(conv.id, conv);
  const state = {
    conversations: map,
    activeConversationId,
    broadcastWs,
  } as unknown as ServerState;
  return { state, broadcastWs };
}

function conv(id: string, roomId: string): ConversationMeta {
  const now = new Date().toISOString();
  return {
    id,
    title: id,
    roomId: roomId as UUID,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Conversation fixture with an explicit updatedAt — the recency fallback keys
 * off this field. Fixture strings used for the "unparseable" cases must be
 * verified NaN under `new Date(...)` — V8/JSC accept surprising strings like
 * "garbage-1" (year 2001), which would silently turn a corrupt-timestamp test
 * into a valid-data test.
 */
function convAt(
  id: string,
  roomId: string,
  updatedAt: string,
): ConversationMeta {
  return { ...conv(id, roomId), updatedAt };
}

/** Verified-unparseable timestamp: new Date("not-a-date").getTime() is NaN. */
const UNPARSEABLE = "not-a-date";

const REQUIRED_RELAY_SOURCES = [
  "client_chat",
  "agent_message_api",
  "compat_openai",
  "compat_anthropic",
];

describe("registerClientChatSendHandler — relay source coverage", () => {
  it("registers every dashboard relay as an internal transport", () => {
    const { runtime, handlers, connectors } = makeRuntime();
    const { state } = makeState([]);
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);

    for (const source of REQUIRED_RELAY_SOURCES) {
      expect(handlers.has(source)).toBe(true);
    }
    expect(connectors).toEqual([]);
  });

  it("keeps dashboard relays out of real runtime connector discovery", () => {
    const runtime = new AgentRuntime({
      character: {
        name: "Dashboard Relay Test Agent",
        bio: ["test"],
        settings: {},
      } as Character,
      adapter: new InMemoryDatabaseAdapter(),
      logLevel: "fatal",
    });
    const { state } = makeState([]);

    registerClientChatSendHandler(runtime, state);

    expect(
      runtime
        .getMessageConnectors()
        .map((connector) => connector.source)
        .filter((source) => REQUIRED_RELAY_SOURCES.includes(source)),
    ).toEqual([]);
  });

  it("does NOT register the dead sources removed from the relay list", () => {
    const { runtime, handlers } = makeRuntime();
    const { state } = makeState([]);
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);

    // `acpx_sub_agent` is not a real inbound origin.source anywhere; the router
    // marker is `sub_agent`, unwrapped to the real originSource before it ever
    // becomes a spawn source. `orchestrator` is only a notifier/trajectory label.
    expect(handlers.has("acpx_sub_agent")).toBe(false);
    expect(handlers.has("orchestrator")).toBe(false);
    expect(handlers.has("sub_agent")).toBe(false);
  });
});

describe("registerClientChatSendHandler — delivery", () => {
  it("delivers a known relay source into the matching conversation", async () => {
    const { runtime, created } = makeRuntime();
    const { state, broadcastWs } = makeState([conv("c1", "room-1")]);
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);

    await runtime.sendMessageToTarget(
      { source: "agent_message_api", roomId: "room-1" as UUID },
      { text: "done" },
    );

    expect(created).toHaveLength(1);
    expect(created[0]?.roomId).toBe("room-1");
    expect(broadcastWs).toHaveBeenCalledTimes(1);
    expect(broadcastWs.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "c1",
    });
  });

  it("preserves distinct sends even when their text is identical", async () => {
    const { runtime, created } = makeRuntime();
    const { state, broadcastWs } = makeState([conv("c1", "room-1")]);
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);

    const target = {
      source: "client_chat",
      roomId: "room-1" as UUID,
    };
    await runtime.sendMessageToTarget(target, { text: "done" });
    await runtime.sendMessageToTarget(target, { text: "done" });

    expect(created).toHaveLength(2);
    expect(created[0]?.id).not.toBe(created[1]?.id);
    expect(broadcastWs).toHaveBeenCalledTimes(2);
  });

  it("delivers an UNKNOWN dashboard-origin source instead of dropping it", async () => {
    const { runtime, created } = makeRuntime();
    const { state, broadcastWs } = makeState([conv("c1", "room-1")]);
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);

    // `my_custom_source` was never explicitly registered (a client-supplied
    // body.source / agent_message_api platformName). It must still be delivered
    // via the default-fallback wrapper rather than throwing "No send handler".
    await expect(
      runtime.sendMessageToTarget(
        { source: "my_custom_source", roomId: "room-1" as UUID },
        { text: "relayed result" },
      ),
    ).resolves.toMatchObject({
      roomId: "room-1",
      content: { text: "relayed result", source: "client_chat" },
    });

    expect(created).toHaveLength(1);
    expect(created[0]?.roomId).toBe("room-1");
    expect(broadcastWs).toHaveBeenCalledTimes(1);
  });

  it("does NOT hijack a registered connector source (discord wins)", async () => {
    const { runtime, created } = makeRuntime();
    const { state, broadcastWs } = makeState([conv("c1", "room-1")]);
    const discordHandler = vi.fn(async () => undefined);
    // A real connector registers its own handler before the dashboard wires up.
    runtime.registerSendHandler("discord", discordHandler);
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);

    await runtime.sendMessageToTarget(
      { source: "discord", roomId: "room-1" as UUID },
      { text: "to discord" },
    );

    expect(discordHandler).toHaveBeenCalledTimes(1);
    // The dashboard deliver path never ran for the connector source.
    expect(created).toHaveLength(0);
    expect(broadcastWs).not.toHaveBeenCalled();
  });
});

describe("swarm synthesis — dashboard transport ownership", () => {
  it("persists and broadcasts once through the real runtime relay", async () => {
    const adapter = new InMemoryDatabaseAdapter();
    await adapter.initialize();
    const runtime = new AgentRuntime({
      character: {
        name: "Dashboard Synthesis Test Agent",
        bio: ["test"],
        settings: {},
      } as Character,
      adapter,
      logLevel: "fatal",
    });
    const roomId = crypto.randomUUID() as UUID;
    const worldId = crypto.randomUUID() as UUID;
    await runtime.createRooms([
      {
        id: roomId,
        worldId,
        source: "client_chat",
        type: ChannelType.DM,
      },
    ]);
    const conversation = conv("c1", roomId);
    const { state, broadcastWs } = makeState([conversation], conversation.id);
    state.runtime = runtime;
    registerClientChatSendHandler(runtime, state);

    try {
      await handleSwarmSynthesis(
        state,
        {
          tasks: [
            {
              sessionId: "pty-dashboard",
              label: "dashboard task",
              agentType: "codex",
              originalTask: "inspect the repository",
              status: "completed",
              completionSummary: "done",
              roomId,
            },
          ],
          total: 1,
          completed: 1,
          stopped: 0,
          errored: 0,
        },
        vi.fn(async () => {
          throw new Error("dashboard fallback must not run");
        }),
      );

      const persisted = await runtime.getMemories({
        roomId,
        tableName: "messages",
      });
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.content).toMatchObject({
        text: "done",
        source: "client_chat",
      });
      expect(broadcastWs).toHaveBeenCalledTimes(1);
      expect(broadcastWs).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "proactive-message",
          conversationId: conversation.id,
          message: expect.objectContaining({
            text: "done",
            source: "client_chat",
          }),
        }),
      );
    } finally {
      await adapter.close();
    }
  });
});

describe("registerClientChatSendHandler — recency fallback ordering", () => {
  // These cases exercise resolveConversation's third fallback (most recently
  // updated conversation): client_chat with a non-matching roomId and no
  // activeConversationId. The resolved conversation is the delivery target —
  // its room gets the persisted message and its id is broadcast.
  function recencyTarget(state: ServerState) {
    const { runtime, created } = makeRuntime();
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);
    return { runtime, created };
  }

  it("delivers into the most recently updated conversation on valid data", async () => {
    const conversations = [
      convAt("c-old", "room-old", "2026-08-20T10:00:00.000Z"),
      convAt("c-new", "room-new", "2026-08-28T10:00:00.000Z"),
    ];
    const { state, broadcastWs } = makeState(conversations);
    const { runtime, created } = recencyTarget(state);

    await runtime.sendMessageToTarget(
      { source: "client_chat", roomId: "room-unknown" as UUID },
      { text: "proactive ping" },
    );

    expect(created).toHaveLength(1);
    expect(created[0]?.roomId).toBe("room-new");
    expect(broadcastWs.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "c-new",
    });
  });

  it("never selects a corrupt-updatedAt conversation when a valid newer one exists", async () => {
    // Insertion order intentionally places the corrupt conversation where the
    // old NaN comparator would surface it first; the total-order comparator
    // must sort it last (epoch 0) regardless.
    const conversations = [
      convAt("c-corrupt", "room-corrupt", UNPARSEABLE),
      convAt("c-valid", "room-valid", "2026-08-28T10:00:00.000Z"),
    ];
    const { state, broadcastWs } = makeState(conversations);
    const { runtime, created } = recencyTarget(state);

    await runtime.sendMessageToTarget(
      { source: "client_chat", roomId: "room-unknown" as UUID },
      { text: "proactive ping" },
    );

    expect(created).toHaveLength(1);
    expect(created[0]?.roomId).toBe("room-valid");
    expect(broadcastWs.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "c-valid",
    });
  });

  it("keeps selection deterministic when only corrupt timestamps exist", async () => {
    const conversations = [
      convAt("c-b", "room-b", UNPARSEABLE),
      convAt("c-a", "room-a", "///"),
      convAt("c-c", "room-c", "not-a-date-either"),
    ];
    const { state, broadcastWs } = makeState(conversations);
    const { runtime, created } = recencyTarget(state);

    await runtime.sendMessageToTarget(
      { source: "client_chat", roomId: "room-unknown" as UUID },
      { text: "proactive ping" },
    );

    // All timestamps coerce to epoch 0; the id tie-break picks the lowest id
    // deterministically instead of leaving [0] to sort-engine whim.
    expect(created[0]?.roomId).toBe("room-a");
    expect(broadcastWs.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "c-a",
    });
  });

  it("tie-breaks equal valid timestamps on id deterministically", async () => {
    const conversations = [
      convAt("c-z", "room-z", "2026-08-28T10:00:00.000Z"),
      convAt("c-y", "room-y", "2026-08-28T10:00:00.000Z"),
    ];
    const { state } = makeState(conversations);
    const { runtime, created } = recencyTarget(state);

    await runtime.sendMessageToTarget(
      { source: "client_chat", roomId: "room-unknown" as UUID },
      { text: "proactive ping" },
    );

    expect(created[0]?.roomId).toBe("room-y");
  });

  it("does not regress explicit room matching or ambient-fallback gating", async () => {
    // Sanity: the fix must not touch paths 1/2 of resolveConversation.
    const conversations = [
      convAt("c-recent", "room-recent", "2026-08-28T10:00:00.000Z"),
      convAt("c-active", "room-active", "2026-08-20T10:00:00.000Z"),
    ];
    // Path 1 — explicit roomId still wins over recency.
    const { state } = makeState(conversations);
    const { runtime, created } = recencyTarget(state);
    await runtime.sendMessageToTarget(
      { source: "client_chat", roomId: "room-active" as UUID },
      { text: "explicit" },
    );
    expect(created[0]?.roomId).toBe("room-active");

    // Path 2 — active conversation still wins over recency.
    const { state: state2 } = makeState(conversations, "c-active");
    const { runtime: rt2, created: created2 } = recencyTarget(state2);
    await rt2.sendMessageToTarget(
      { source: "client_chat", roomId: "room-unknown" as UUID },
      { text: "active wins" },
    );
    expect(created2[0]?.roomId).toBe("room-active");
  });
});

describe("registerClientChatSendHandler — cross-conversation safety", () => {
  it("does NOT mis-deliver an API result into an unrelated active conversation", async () => {
    const { runtime, created } = makeRuntime();
    // The dashboard has an active conversation; the API caller's room is NOT a
    // registered dashboard conversation.
    const { state, broadcastWs } = makeState([conv("c1", "room-1")], "c1");
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);

    await expect(
      runtime.sendMessageToTarget(
        { source: "agent_message_api", roomId: "room-api" as UUID },
        { text: "async sub-agent result" },
      ),
    ).rejects.toThrow(/no conversation available/);

    // Crucially, nothing landed in the unrelated active conversation.
    expect(created).toHaveLength(0);
    expect(broadcastWs).not.toHaveBeenCalled();
  });

  it("still lets a proactive client_chat message use the active-conversation fallback", async () => {
    const { runtime, created } = makeRuntime();
    const { state, broadcastWs } = makeState([conv("c1", "room-1")], "c1");
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);

    // No roomId / non-matching room: the live dashboard UI surface (client_chat)
    // is allowed to fall back to the active conversation.
    await runtime.sendMessageToTarget(
      { source: "client_chat", roomId: "room-unknown" as UUID },
      { text: "proactive ping" },
    );

    expect(created).toHaveLength(1);
    expect(created[0]?.roomId).toBe("room-1");
    expect(broadcastWs).toHaveBeenCalledTimes(1);
  });
});

describe("registerClientChatSendHandler — connector discovery failure is observable", () => {
  it("surfaces a missing connector-discovery API instead of falling back to the dashboard", async () => {
    const { runtime, created } = makeRuntime();
    delete (runtime as { getMessageConnectors?: unknown }).getMessageConnectors;
    const { state, broadcastWs } = makeState([conv("c1", "room-1")]);
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);

    const result = runtime.sendMessageToTarget(
      { source: "my_custom_source", roomId: "room-1" as UUID },
      { text: "relayed result" },
    );
    await expect(result).rejects.toMatchObject({
      name: "ElizaError",
      message: expect.stringMatching(/connector discovery unavailable/),
      code: "CONNECTOR_DISCOVERY_UNAVAILABLE",
      context: { source: "my_custom_source" },
      severity: "fatal",
    });

    expect(created).toHaveLength(0);
    expect(broadcastWs).not.toHaveBeenCalled();
  });

  it("propagates a throwing connector-discovery API instead of rerouting to the dashboard", async () => {
    const { runtime, created } = makeRuntime();
    (runtime as { getMessageConnectors?: unknown }).getMessageConnectors =
      () => {
        throw new Error("registry exploded");
      };
    const { state, broadcastWs } = makeState([conv("c1", "room-1")]);
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);

    await expect(
      runtime.sendMessageToTarget(
        { source: "my_custom_source", roomId: "room-1" as UUID },
        { text: "relayed result" },
      ),
    ).rejects.toThrow(/registry exploded/);

    expect(created).toHaveLength(0);
    expect(broadcastWs).not.toHaveBeenCalled();
  });

  it("still delivers explicit dashboard relay sources when discovery is broken", async () => {
    // The relay seam (registerInternalSendHandler) is independent of connector
    // discovery: client_chat must remain addressable even when the registry is
    // broken, per the first acceptance criterion.
    const { runtime, created } = makeRuntime();
    delete (runtime as { getMessageConnectors?: unknown }).getMessageConnectors;
    const { state, broadcastWs } = makeState([conv("c1", "room-1")]);
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);

    await runtime.sendMessageToTarget(
      { source: "client_chat", roomId: "room-1" as UUID },
      { text: "relayed result" },
    );

    expect(created).toHaveLength(1);
    expect(created[0]?.roomId).toBe("room-1");
    expect(broadcastWs).toHaveBeenCalledTimes(1);
  });
});
