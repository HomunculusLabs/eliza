/**
 * Static package-boundary checks prohibit ambient credentials, broad provider
 * imports, filesystem auth, and endpoint escape hatches in maintained source.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLOSED_PI_AUTH_CONTEXT } from "../credentials/closed-auth-context.js";
import packageJson from "../package.json";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function productionSources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name === "__tests__" ||
      entry.name === "dist" ||
      entry.name === "node_modules"
    ) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...productionSources(path));
    else if (entry.name.endsWith(".ts") && entry.name !== "build.ts")
      files.push(path);
  }
  return files;
}

describe("Pi package security and export contract", () => {
  it("declares correct root/catalog JS and declaration exports", () => {
    expect(packageJson.main).toBe("./dist/index.js");
    expect(packageJson.types).toBe("./dist/index.d.ts");
    expect(packageJson.files).toEqual(["dist"]);
    expect(packageJson.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      default: "./dist/index.js",
    });
    expect(packageJson.exports["./catalog"]).toEqual({
      types: "./dist/catalog/index.d.ts",
      import: "./dist/catalog/index.js",
      default: "./dist/catalog/index.js",
    });
    expect(packageJson.peerDependencies["@elizaos/core"]).toBe("workspace:*");
    expect(packageJson.dependencies["@earendil-works/pi-ai"]).toBe("0.84.1");
  });

  it("keeps the injected Pi auth context closed to environment and files", async () => {
    await expect(
      CLOSED_PI_AUTH_CONTEXT.env("OPENAI_API_KEY"),
    ).resolves.toBeUndefined();
    await expect(
      CLOSED_PI_AUTH_CONTEXT.fileExists?.("~/.pi/agent/auth.json"),
    ).resolves.toBe(false);
  });

  it("contains no forbidden ambient/auth/provider behavior in production source", () => {
    const forbidden = [
      ["direct process environment", /process\s*\.\s*env/],
      ["broad Pi provider import", /providers\/all/],
      ["filesystem module", /(?:node:)?fs(?:\/promises)?["']/],
      ["home-directory lookup", /\bhomedir\s*\(/],
      ["Pi Agent auth file", /\.pi\/agent\/auth\.json/],
      ["process execution", /node:child_process|\bexecFile?\s*\(|\bspawn\s*\(/],
    ] as const;
    const violations: string[] = [];
    for (const path of productionSources(packageRoot)) {
      const source = readFileSync(path, "utf8");
      for (const [label, pattern] of forbidden) {
        if (pattern.test(source)) {
          violations.push(`${relative(packageRoot, path)}: ${label}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
