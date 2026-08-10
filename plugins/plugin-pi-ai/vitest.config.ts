/**
 * Runs the deterministic package-foundation tests without provider network access.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
