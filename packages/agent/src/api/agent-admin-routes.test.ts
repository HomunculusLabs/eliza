/**
 * Covers reset-time vault cleanup with an in-memory idempotent remove surface.
 * The test pins canonical cloud/upstream keys and redacted best-effort failure
 * reporting without invoking the destructive runtime/database reset route.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type AgentAdminRouteContext,
  type AgentAdminRouteState,
  clearResetVaultCredentials,
  handleAgentAdminRoutes,
} from "./agent-admin-routes.ts";

describe("clearResetVaultCredentials", () => {
  it("removes cloud plus exact OpenAI/Anthropic provider references", async () => {
    const values = new Set([
      "ELIZAOS_CLOUD_API_KEY",
      "ELIZAOS_CLOUD_BASE_URL",
      "ELIZAOS_CLOUD_ENABLED",
      "providers.openai.api-key",
      "providers.anthropic.api-key",
      "providers.pi.api-key",
    ]);
    const remove = vi.fn(async (key: string) => {
      values.delete(key);
    });
    const logWarn = vi.fn();

    await clearResetVaultCredentials({ remove }, logWarn);
    await clearResetVaultCredentials({ remove }, logWarn);

    const expected = [
      "ELIZAOS_CLOUD_API_KEY",
      "ELIZAOS_CLOUD_BASE_URL",
      "ELIZAOS_CLOUD_ENABLED",
      "providers.openai.api-key",
      "providers.anthropic.api-key",
    ];
    expect(
      remove.mock.calls.slice(0, expected.length).map(([key]) => key),
    ).toEqual(expected);
    expect(values).toEqual(new Set(["providers.pi.api-key"]));
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("continues after removal failures and warns without backend text", async () => {
    const remove = vi.fn(async (key: string) => {
      if (key === "providers.openai.api-key") {
        throw new Error("backend echoed plaintext-secret");
      }
    });
    const logWarn = vi.fn();

    await expect(
      clearResetVaultCredentials({ remove }, logWarn),
    ).rejects.toMatchObject({
      code: "RESET_PROVIDER_CREDENTIAL_CLEANUP_FAILED",
      failedRefs: ["providers.openai.api-key"],
    });

    expect(remove).toHaveBeenCalledWith("providers.anthropic.api-key");
    expect(logWarn).toHaveBeenCalledOnce();
    expect(logWarn.mock.calls[0]?.[0]).not.toContain("plaintext-secret");
  });

  it("returns an actionable failed reset state when an upstream key cannot be removed", async () => {
    const backendSecret = "vault-backend-plaintext";
    const config = {
      serviceRouting: {
        llmText: {
          backend: "pi",
          transport: "direct",
          primaryModel: "openai/gpt-5.4-mini",
        },
      },
      env: {
        OPENAI_API_KEY: "vault://providers.openai.api-key",
        vars: {
          ANTHROPIC_API_KEY: "vault://providers.anthropic.api-key",
        },
      },
    } as AgentAdminRouteState["config"];
    const state: AgentAdminRouteState = {
      runtime: null,
      config,
      agentState: "running",
      agentName: "Eliza",
      model: "openai/gpt-5.4-mini",
      startedAt: 1,
      chatRoomId: null,
      chatUserId: null,
      chatConnectionReady: null,
      chatConnectionPromise: null,
      pendingRestartReasons: [],
      conversations: new Map([["stale", {}]]),
      activeConversationId: "stale",
      conversationRestorePromise: Promise.resolve(),
    };
    const remove = vi.fn(async (key: string) => {
      if (key === "providers.openai.api-key") {
        throw new Error(backendSecret);
      }
    });
    const saveResetConfig = vi.fn();
    const logWarn = vi.fn();
    const responses: Array<{ message: string; status: number }> = [];
    const handled = await handleAgentAdminRoutes({
      req: {} as AgentAdminRouteContext["req"],
      res: {} as AgentAdminRouteContext["res"],
      method: "POST",
      pathname: "/api/agent/reset",
      state,
      resolveStateDir: () => "/tmp/pi-reset-route-test",
      stateDirExists: () => false,
      removeStateDir: () => {},
      logWarn,
      loadResetConfig: () => config,
      saveResetConfig,
      resetVault: { remove },
      json: () => {
        throw new Error("reset must not report healthy success");
      },
      error: (_res, message, status) => {
        responses.push({ message, status: status ?? 500 });
      },
    } as AgentAdminRouteContext);

    expect(handled).toBe(true);
    expect(saveResetConfig).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("providers.anthropic.api-key");
    expect(state.agentState).toBe("error");
    expect(state.pendingRestartReasons).toEqual([
      "Reset incomplete: canonical provider credential cleanup failed",
    ]);
    expect(state.chatRoomId).toBeNull();
    expect(state.chatConnectionPromise).toBeNull();
    expect(state.conversations?.size).toBe(0);
    expect(state.activeConversationId).toBeNull();
    expect(state.conversationRestorePromise).toBeNull();
    expect(JSON.stringify(state.config)).not.toContain(
      "providers.openai.api-key",
    );
    expect(JSON.stringify(state.config)).not.toContain(
      "providers.anthropic.api-key",
    );
    expect(responses).toEqual([
      {
        message:
          "Reset incomplete: canonical provider credentials could not be removed; retry reset before restarting.",
        status: 500,
      },
    ]);
    expect(
      JSON.stringify({ responses, logs: logWarn.mock.calls }),
    ).not.toContain(backendSecret);
  });
});
