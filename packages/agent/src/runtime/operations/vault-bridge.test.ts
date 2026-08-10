/** Tests redacted provider-key compensation and optimized-prompt key reuse. */

import type { SetOptions } from "@elizaos/vault";
import { describe, expect, it, vi } from "vitest";
import {
  removeProviderApiKey,
  resolveOptimizedPromptIntegrityKey,
  restoreProviderApiKey,
  snapshotProviderApiKey,
} from "./vault-bridge.ts";

function mutableVault(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    vault: {
      has: vi.fn(async (key: string) => values.has(key)),
      get: vi.fn(async (key: string) => {
        const value = values.get(key);
        if (value === undefined) throw new Error("missing");
        return value;
      }),
      set: vi.fn(async (key: string, value: string, _options?: SetOptions) => {
        values.set(key, value);
      }),
      remove: vi.fn(async (key: string) => {
        values.delete(key);
      }),
    },
  };
}

describe("provider API-key compensation", () => {
  it.each([
    ["openai", "providers.openai.api-key"],
    ["anthropic", "providers.anthropic.api-key"],
  ] as const)(
    "restores the exact %s key without serializing its value",
    async (normalizedProvider, apiKeyRef) => {
      const priorSecret = `prior-${normalizedProvider}-secret`;
      const fake = mutableVault({ [apiKeyRef]: priorSecret });
      const snapshot = await snapshotProviderApiKey({
        vault: fake.vault,
        normalizedProvider,
        caller: "test:snapshot",
      });

      expect(snapshot).toEqual({ apiKeyRef, existed: true });
      expect(JSON.stringify(snapshot)).not.toContain(priorSecret);
      fake.values.set(apiKeyRef, "replacement-secret");
      await restoreProviderApiKey({
        vault: fake.vault,
        snapshot,
        caller: "test:restore",
      });

      expect(fake.values.get(apiKeyRef)).toBe(priorSecret);
      expect(fake.vault.set).toHaveBeenCalledWith(apiKeyRef, priorSecret, {
        sensitive: true,
        caller: "test:restore",
      });
    },
  );

  it("restores prior absence through idempotent remove", async () => {
    const fake = mutableVault();
    const snapshot = await snapshotProviderApiKey({
      vault: fake.vault,
      normalizedProvider: "openai",
      caller: "test:snapshot",
    });
    fake.values.set("providers.openai.api-key", "new-secret");

    await restoreProviderApiKey({
      vault: fake.vault,
      snapshot,
      caller: "test:restore",
    });

    expect(snapshot).toEqual({
      apiKeyRef: "providers.openai.api-key",
      existed: false,
    });
    expect(fake.values.has("providers.openai.api-key")).toBe(false);
    expect(fake.vault.remove).toHaveBeenCalledWith("providers.openai.api-key");
  });

  it("removes only the canonical upstream key and redacts failures", async () => {
    const fake = mutableVault({
      "providers.anthropic.api-key": "remove-me",
      "providers.openai.api-key": "keep-me",
    });
    expect(
      await removeProviderApiKey({
        vault: fake.vault,
        normalizedProvider: "anthropic",
        caller: "agent-reset",
      }),
    ).toBe("providers.anthropic.api-key");
    expect(fake.values.has("providers.anthropic.api-key")).toBe(false);
    expect(fake.values.get("providers.openai.api-key")).toBe("keep-me");

    fake.vault.remove.mockRejectedValueOnce(
      new Error("backend echoed remove-me"),
    );
    const failure = removeProviderApiKey({
      vault: fake.vault,
      normalizedProvider: "anthropic",
      caller: "agent-reset",
    });
    await expect(failure).rejects.toThrow("providers.anthropic.api-key");
    await expect(failure).rejects.not.toThrow("remove-me");
  });
});

describe("resolveOptimizedPromptIntegrityKey", () => {
  it("persists one sensitive 256-bit key", async () => {
    const values = new Map<string, string>();
    const vault = {
      has: vi.fn(async (key: string) => values.has(key)),
      get: vi.fn(async (key: string) => {
        const value = values.get(key);
        if (!value) throw new Error("missing");
        return value;
      }),
      setIfAbsent: vi.fn(
        async (key: string, value: string): Promise<boolean> => {
          if (values.has(key)) return false;
          values.set(key, value);
          return true;
        },
      ),
    };

    const first = await resolveOptimizedPromptIntegrityKey(vault);
    const second = await resolveOptimizedPromptIntegrityKey(vault);

    expect(Buffer.from(first, "base64")).toHaveLength(32);
    expect(second).toBe(first);
    expect(vault.setIfAbsent).toHaveBeenCalledOnce();
    expect(vault.setIfAbsent).toHaveBeenCalledWith(
      "system.optimized-prompt.hmac-key",
      first,
      { sensitive: true, caller: "runtime-boot" },
    );
  });

  it("uses the winner when another process creates the key first", async () => {
    const winner = Buffer.alloc(32, 7).toString("base64");
    const vault = {
      has: vi.fn(async () => false),
      get: vi.fn(async () => winner),
      setIfAbsent: vi.fn(async () => false),
    };

    expect(await resolveOptimizedPromptIntegrityKey(vault)).toBe(winner);
    expect(vault.get).toHaveBeenCalledOnce();
  });
});
