/**
 * Mock-contract regression for the canonical @capacitor/core test stub
 * (test/stubs/capacitor-core.ts). Pins the contract that production modules
 * rely on at module scope — notably platform/remote-controller.ts, whose
 * eager `Capacitor.registerPlugin("RemoteControllerIdentity")` crashed 39
 * suites whose partial mock factories omitted registerPlugin (#29862).
 * Deterministic unit suite over the stub itself plus a real module-load of
 * remote-controller under the stub.
 */

import { describe, expect, it, vi } from "vitest";

const canonical = await vi.importActual<
  typeof import("../../test/stubs/capacitor-core")
>("../../test/stubs/capacitor-core");

vi.mock("@capacitor/core", async () => {
  return {
    ...(await vi.importActual<typeof import("../../test/stubs/capacitor-core")>(
      "../../test/stubs/capacitor-core",
    )),
  };
});

// Real module-load proof: remote-controller evaluates
// Capacitor.registerPlugin at module scope; under the canonical stub this
// import must not throw (#29862 module-load crash class).
const remoteController = await import("../platform/remote-controller");

describe("canonical @capacitor/core stub contract", () => {
  it("exposes the runtime Capacitor surface including registerPlugin", () => {
    expect(typeof canonical.Capacitor.registerPlugin).toBe("function");
    expect(typeof canonical.Capacitor.getPlatform).toBe("function");
    expect(typeof canonical.Capacitor.isNativePlatform).toBe("function");
    expect(typeof canonical.Capacitor.isPluginAvailable).toBe("function");
  });

  it("registerPlugin returns a stable per-name plugin object", () => {
    canonical.__resetCapacitorForTests();
    const a = canonical.Capacitor.registerPlugin("P1");
    const b = canonical.Capacitor.registerPlugin("P1");
    const c = canonical.Capacitor.registerPlugin("P2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("registers RemoteControllerIdentity eagerly at module load without throwing", () => {
    // If this suite loaded at all, remote-controller.ts module-scope
    // registration succeeded. Assert the public surface is importable and
    // the expected functions exist.
    expect(typeof remoteController.getOrCreateRemoteControllerIdentity).toBe(
      "function",
    );
    expect(typeof remoteController.createRemoteCommand).toBe("function");
  });

  it("defaults to the web platform so platform gates stay deterministic", () => {
    expect(canonical.Capacitor.getPlatform()).toBe("web");
    expect(canonical.Capacitor.isNativePlatform()).toBe(false);
    expect(canonical.Capacitor.isPluginAvailable("anything")).toBe(false);
  });

  it("keeps a registered plugin replaceable for suites that exercise it", async () => {
    canonical.__resetCapacitorForTests();
    const replacement = {
      start: async () => ({ ok: true }),
    };
    canonical.__setPluginForTests("Probe", replacement);
    // A later registerPlugin for the same name returns the replacement, so
    // suites can inject a shaped plugin before importing the consumer module.
    const plugin = canonical.Capacitor.registerPlugin("Probe");
    expect(plugin).toBe(replacement);
    await expect(plugin.start()).resolves.toEqual({ ok: true });
  });

  it("exposes the CapacitorHttp surface suites override per-case", () => {
    expect(typeof canonical.CapacitorHttp.get).toBe("function");
    expect(typeof canonical.CapacitorHttp.post).toBe("function");
    expect(typeof canonical.CapacitorHttp.request).toBe("function");
  });
});
