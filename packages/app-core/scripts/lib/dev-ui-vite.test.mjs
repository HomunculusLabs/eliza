/** Verifies the development Vite subprocess resolves source TypeScript config imports. */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { resolveViteCommand } from "./dev-ui-vite.mjs";

const appDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../app",
);

test("resolveViteCommand keeps the Vite 8 config and React plugin on one loader", () => {
  const resolved = resolveViteCommand({
    appDir,
    runtime: "node",
    runtimePath: "/test/runtime",
    port: 2138,
  });

  expect(resolved.command).toBe("/test/runtime");
  expect(resolved.args).toEqual([
    "--conditions=eliza-source",
    "--import",
    "tsx",
    path.join(appDir, "node_modules", "vite", "bin", "vite.js"),
    "--configLoader",
    "bundle",
    "--port",
    "2138",
  ]);
});

test("resolveViteCommand stays Bun-backed when its caller runs under Bun", () => {
  const helperUrl = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "dev-ui-vite.mjs"),
  ).href;
  const script = `
    import { resolveViteCommand } from ${JSON.stringify(helperUrl)};
    const resolved = resolveViteCommand({ appDir: ${JSON.stringify(appDir)} });
    process.stdout.write(JSON.stringify(resolved));
  `;
  const resolution = spawnSync("bun", ["--eval", script], {
    encoding: "utf8",
    env: { ...process.env, ELIZA_NODE_PATH: "" },
  });

  expect(resolution.status, resolution.stderr).toBe(0);
  const resolved = JSON.parse(resolution.stdout);
  expect(resolved.args).not.toContain("tsx");
  const runtimePath = resolved.command;
  const runtime = spawnSync(
    runtimePath,
    [
      "--eval",
      "process.stdout.write(process.versions.bun ? 'bun' : 'node:' + process.versions.node)",
    ],
    { encoding: "utf8" },
  );
  expect(runtime.status, runtime.stderr).toBe(0);
  expect(runtime.stdout).toBe("bun");
});

test("the supervised dev command resolves a Node 24+ Vite runtime under Bun", () => {
  const supervisedHelperUrl = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "dev-ui-vite.mjs"),
  ).href;
  const script = `
    import { resolveSupervisedViteCommand } from ${JSON.stringify(supervisedHelperUrl)};
    const resolved = resolveSupervisedViteCommand({
      appDir: ${JSON.stringify(appDir)},
      port: 2138,
      env: process.env,
    });
    process.stdout.write(JSON.stringify(resolved));
  `;
  // Run under Bun — exactly how `bun run dev` launches the orchestrator — so a
  // resolver that kept the orchestrator executable would hand Vite the Bun
  // binary; the supervised contract must still hand back a probed Node 24+.
  const resolution = spawnSync("bun", ["--eval", script], {
    encoding: "utf8",
    env: { ...process.env, ELIZA_NODE_PATH: "" },
  });

  expect(resolution.status, resolution.stderr).toBe(0);
  const resolved = JSON.parse(resolution.stdout);
  expect(resolved.args).toContain("tsx");
  expect(resolved.args).toContain("--configLoader");
  const runtime = spawnSync(
    resolved.command,
    [
      "--eval",
      "process.stdout.write(process.versions.bun ? 'bun' : 'node:' + process.versions.node)",
    ],
    { encoding: "utf8" },
  );
  expect(runtime.status, runtime.stderr).toBe(0);
  expect(runtime.stdout).toMatch(/^node:(\d+)/);
  const major = Number.parseInt(runtime.stdout.slice("node:".length), 10);
  expect(major).toBeGreaterThanOrEqual(24);
});

test("the combined dev supervisor uses the supervised Vite command", () => {
  // Source contract (repo-established pattern, cf. dev-vite-command.test.mjs):
  // startVite must go through resolveSupervisedViteCommand — the generic
  // resolveViteCommand default would relapse to the Bun orchestrator binary.
  const devUiSource = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dev-ui.mjs"),
    "utf8",
  );
  expect(devUiSource).toMatch(/resolveSupervisedViteCommand\(\{/);
  expect(devUiSource).toMatch(
    /import \{\s*resolveSupervisedViteCommand,?\s*\} from "\.\/lib\/dev-ui-vite\.mjs"/,
  );
});
