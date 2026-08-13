/**
 * Exercises the messaging gateway preflight CLI as a deterministic subprocess contract.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./messaging-gateway-preflight.mjs", import.meta.url));

const managedEnvironmentNames = [
  "ELIZA_APP_WEBHOOK_GATEWAY_URL",
  "WEBHOOK_GATEWAY_URL",
  "GATEWAY_WEBHOOK_URL",
  "ELIZA_APP_WEBHOOK_GATEWAY_SECRET",
];

function runPreflight({ channels = "webhook", env = {} } = {}) {
  const childEnv = { ...process.env };
  for (const name of managedEnvironmentNames) {
    delete childEnv[name];
  }
  Object.assign(childEnv, env);

  const result = spawnSync("node", [scriptPath, "--strict", `--channels=${channels}`], {
    env: childEnv,
    encoding: "utf8",
  });

  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

describe("messaging gateway preflight CLI", () => {
  for (const urlName of [
    "ELIZA_APP_WEBHOOK_GATEWAY_URL",
    "WEBHOOK_GATEWAY_URL",
    "GATEWAY_WEBHOOK_URL",
  ]) {
    test(`accepts the ${urlName} URL alias`, () => {
      const result = runPreflight({
        env: {
          [urlName]: "https://gateway.example.test",
          ELIZA_APP_WEBHOOK_GATEWAY_SECRET: "forwarder-secret",
        },
      });

      expect(result.status).toBe(0);
      expect(result.output).toContain("All gateway preflight checks passed.");
    });
  }

  test("trims channel names and configured values", () => {
    const result = runPreflight({
      channels: " webhook ",
      env: {
        ELIZA_APP_WEBHOOK_GATEWAY_URL: "  https://gateway.example.test  ",
        ELIZA_APP_WEBHOOK_GATEWAY_SECRET: "  forwarder-secret  ",
      },
    });

    expect(result.status).toBe(0);
  });

  test("fails strict mode when required values are blank", () => {
    const result = runPreflight({
      env: {
        ELIZA_APP_WEBHOOK_GATEWAY_URL: "  ",
        ELIZA_APP_WEBHOOK_GATEWAY_SECRET: "\t",
      },
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain("2 gateway preflight check(s) failed.");
  });

  test("fails strict mode for an unknown channel", () => {
    const result = runPreflight({ channels: "shraed" });

    expect(result.status).toBe(1);
    expect(result.output).toContain("unknown channel: shraed");
    expect(result.output).not.toContain("All gateway preflight checks passed.");
  });

  test("fails strict mode for an empty channel selection", () => {
    const result = runPreflight({ channels: "" });

    expect(result.status).toBe(1);
    expect(result.output).toContain("--channels must select at least one channel");
    expect(result.output).not.toContain("All gateway preflight checks passed.");
  });
});
