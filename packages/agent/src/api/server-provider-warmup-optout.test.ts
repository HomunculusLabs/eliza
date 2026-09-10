/**
 * Proves `startApiServer`'s `skipDeferredStartupWork` opt-out suppresses the
 * background provider-model discovery dispatch against a real AgentRuntime and
 * TCP API host (#30976): under the opt-out the real server must not fetch any
 * provider catalog nor write the `state/models/<provider>.json` cache (a late
 * write raced isolated consumers' teardown and failed cleanup with ENOTEMPTY),
 * while ordinary startup still dispatches discovery with a controlled provider
 * transport. Only the network transport is stubbed; server, routes, discovery,
 * and cache writes are real.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime, InMemoryDatabaseAdapter } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startApiServer } from "./server.ts";

type ApiServer = Awaited<ReturnType<typeof startApiServer>>;

const API_TOKEN = "provider-warmup-optout-token";

const originalEnv = new Map<string, string | undefined>();
const touchedEnv = [
  "DATABASE_URL",
  "ELIZA_API_AUTH_TOKEN",
  "ELIZA_API_BIND_HOST",
  "ELIZA_API_PORT",
  "ELIZA_API_TOKEN",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_PORT",
  "ELIZA_STATE_DIR",
  "PGLITE_DATA_DIR",
  "POSTGRES_URL",
] as const;

function snapshotEnvironment(): void {
  originalEnv.clear();
  for (const key of touchedEnv) originalEnv.set(key, process.env[key]);
}

function restoreEnvironment(): void {
  for (const key of touchedEnv) {
    const original = originalEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  originalEnv.clear();
}

async function seedState(root: string): Promise<void> {
  const stateDir = path.join(root, "state");
  const pgliteDir = path.join(stateDir, "pglite");
  await mkdir(pgliteDir, { recursive: true });
  const configPath = path.join(stateDir, "eliza.json");
  await writeFile(
    configPath,
    JSON.stringify({ logging: { level: "error" } }),
    "utf8",
  );

  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.PGLITE_DATA_DIR = pgliteDir;
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
  process.env.ELIZA_API_BIND_HOST = "127.0.0.1";
  process.env.ELIZA_API_TOKEN = API_TOKEN;
  delete process.env.ELIZA_API_AUTH_TOKEN;
  delete process.env.POSTGRES_URL;
  delete process.env.DATABASE_URL;
}

/** Provider transport under test: records every dispatch, answers OpenRouter's
 * two catalog endpoints with one model each and rejects everything else. */
function installControlledTransport(): {
  dispatchedUrls: () => string[];
} {
  const urls: string[] = [];
  const openrouterChatBody = {
    data: [
      {
        id: "control/control-1",
        name: "Control Model 1",
        architecture: { modality: "text->text", output_modalities: ["text"] },
      },
    ],
  };
  const openrouterEmbedBody = { data: [] };
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    urls.push(url);
    if (url.startsWith("https://openrouter.ai/")) {
      const body = url.includes("embeddings")
        ? openrouterEmbedBody
        : openrouterChatBody;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("controlled transport: not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { dispatchedUrls: () => [...urls] };
}

const isProviderCatalogDispatch = (url: string): boolean =>
  url.includes("openrouter.ai/api/v1") ||
  url.includes("/v1/models") ||
  /:\d+\/api\/tags|\/api\/tags/.test(url);

async function withApiServer(
  opts: { skipDeferredStartupWork?: boolean },
  run: (api: ApiServer, dispatchedUrls: () => string[]) => Promise<void>,
): Promise<void> {
  snapshotEnvironment();
  const root = await mkdtemp(path.join(tmpdir(), "eliza-provider-optout-"));
  let runtime: AgentRuntime | null = null;
  let api: ApiServer | null = null;
  const transport = installControlledTransport();
  try {
    await seedState(root);
    runtime = new AgentRuntime({ logLevel: "fatal", plugins: [] });
    runtime.registerDatabaseAdapter(new InMemoryDatabaseAdapter());
    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

    api = await startApiServer({
      port: 0,
      runtime,
      ...opts,
    });
    process.env.ELIZA_PORT = String(api.port);
    process.env.ELIZA_API_PORT = String(api.port);

    await run(api, transport.dispatchedUrls);
  } finally {
    if (api) await api.close();
    if (runtime) {
      await runtime.stop({ fast: true });
      await runtime.close();
    }
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
}

const settle = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until predicate holds or deadline passes; returns last value. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await settle(100);
  }
  return predicate();
}

const openrouterCachePath = (): string =>
  path.join(process.env.ELIZA_STATE_DIR as string, "models", "openrouter.json");

beforeEach(() => {
  vi.spyOn(process, "availableMemory").mockReturnValue(512 * 1024 * 1024);
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnvironment();
});

describe("skipDeferredStartupWork provider cache warmup opt-out", () => {
  it("does not dispatch provider discovery nor write the models cache under the opt-out", async () => {
    await withApiServer(
      { skipDeferredStartupWork: true },
      async (_api, dispatchedUrls) => {
        // Generous settling window: a dispatch that slipped past the opt-out
        // fires within milliseconds of listen (stubbed transport resolves
        // immediately), so one second proves absence, not timing luck.
        await settle(1000);
        expect(dispatchedUrls().filter(isProviderCatalogDispatch)).toEqual([]);
        expect(existsSync(openrouterCachePath())).toBe(false);
      },
    );
  }, 120_000);

  it("ordinary startup still dispatches discovery and warms the cache", async () => {
    await withApiServer({}, async (_api, dispatchedUrls) => {
      const dispatched = await waitFor(
        () => dispatchedUrls().some(isProviderCatalogDispatch),
        10_000,
      );
      expect(dispatched).toBe(true);
      const warmed = await waitFor(
        () => existsSync(openrouterCachePath()),
        10_000,
      );
      expect(warmed).toBe(true);
    });
  }, 120_000);
});
