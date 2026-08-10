/**
 * Tests configuration helpers that guard destructive reset paths and serialize
 * first-run provider options. The reset cases pin filesystem safety; provider
 * projection cases ensure hidden configuration-only backends stay out of UI
 * onboarding responses.
 */
import { describe, expect, it } from "vitest";
import {
  getProviderOptions,
  isSafeResetStateDir,
} from "./server-helpers-config";

describe("getProviderOptions", () => {
  it("does not expose the configuration-only Pi backend during onboarding", () => {
    const providers = getProviderOptions();

    expect(providers.some((provider) => provider.id === "pi")).toBe(false);
    expect(providers.some((provider) => provider.id === "openai")).toBe(true);
  });
});

describe("isSafeResetStateDir", () => {
  const home = "/home/user";

  it("allows a state dir under home that carries an 'eliza' segment", () => {
    expect(isSafeResetStateDir("/home/user/.local/state/eliza", home)).toBe(
      true,
    );
    expect(isSafeResetStateDir("/home/user/eliza", home)).toBe(true);
  });

  it("refuses the filesystem root", () => {
    expect(isSafeResetStateDir("/", home)).toBe(false);
  });

  it("refuses the home directory itself", () => {
    expect(isSafeResetStateDir(home, home)).toBe(false);
  });

  it("refuses any directory outside home (even with an eliza segment)", () => {
    expect(isSafeResetStateDir("/tmp/eliza", home)).toBe(false);
    expect(isSafeResetStateDir("/var/lib/eliza", home)).toBe(false);
  });

  it("refuses a traversal that escapes home", () => {
    expect(isSafeResetStateDir("/home/user/../etc/eliza", home)).toBe(false);
  });

  it("refuses a dir under home that lacks the allowed segment", () => {
    expect(isSafeResetStateDir("/home/user/Documents", home)).toBe(false);
    expect(
      isSafeResetStateDir("/home/user/.local/state/custom-app", home),
    ).toBe(false);
  });
});
