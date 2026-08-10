/**
 * Verifies the static no-network first-run fallback exposes only providers that
 * are explicitly eligible for onboarding. The test exercises the real shared
 * catalog projection without rendering UI or contacting an agent server.
 */
import { describe, expect, it } from "vitest";
import { buildStaticFirstRunOptions } from "./startup-first-run-options";

describe("buildStaticFirstRunOptions", () => {
  it("keeps configuration-only Pi hidden while retaining visible providers", () => {
    const options = buildStaticFirstRunOptions("en");

    expect(options.providers.some((provider) => provider.id === "pi")).toBe(
      false,
    );
    expect(options.providers.some((provider) => provider.id === "openai")).toBe(
      true,
    );
  });
});
