#!/usr/bin/env bun
/**
 * Builds the Node-only gateway root and its side-effect-free static catalog.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-pi-ai",
  targets: [
    {
      label: "Node",
      entry: "index.ts",
      outSubdir: ".",
      target: "node",
      format: "esm",
    },
    {
      label: "Static catalog",
      entry: "catalog/index.ts",
      outSubdir: "catalog",
      target: "browser",
      format: "esm",
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsEmitDeclarationOnly: true,
});
