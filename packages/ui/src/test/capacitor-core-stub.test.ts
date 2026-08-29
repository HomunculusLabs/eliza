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
import type { CanonicalCapacitorPluginStub } from "../../test/stubs/capacitor-core";

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
    // Suites can inject a shaped plugin before importing the consumer module;
    // a later registerPlugin for the same name returns the replacement.
    const base = canonical.Capacitor.registerPlugin("Shaped");
    const shaped: CanonicalCapacitorPluginStub = {
      addListener: (eventName, listener) =>
        base.addListener(eventName, listener),
      removeListener: (eventName, listener) =>
        base.removeListener(eventName, listener),
      removeAllListeners: (eventName) => base.removeAllListeners(eventName),
      start: async () => ({ ok: true }),
    };
    canonical.__setPluginForTests("Probe", shaped);
    const plugin = canonical.Capacitor.registerPlugin("Probe");
    expect(plugin).toBe(shaped);
    await expect(plugin.start()).resolves.toEqual({ ok: true });
  });

  it("exposes callable methods on registered plugins, rejecting unimplemented ones descriptively", async () => {
    canonical.__resetCapacitorForTests();
    const plugin = canonical.Capacitor.registerPlugin("Probe");
    // Unknown methods must be callable (runtime proxy shape), not undefined —
    // production code reaching an unmocked method gets the runtime-style
    // descriptive rejection, never "undefined is not a function".
    expect(typeof plugin.getOrCreateIdentity).toBe("function");
    await expect(plugin.getOrCreateIdentity()).rejects.toThrow(
      /not implemented in the canonical test stub/,
    );
  });

  it("never makes registered plugins accidentally thenable", async () => {
    canonical.__resetCapacitorForTests();
    const plugin = canonical.Capacitor.registerPlugin("Probe");
    // A synthetic `then` callable would make Promise.resolve(plugin) invoke a
    // never-settling callback and hang the awaiting caller.
    expect((plugin as { then?: unknown }).then).toBeUndefined();
    const resolved = await Promise.resolve(plugin);
    expect(resolved).toBe(plugin);
  });

  it("keeps listener add/remove semantics intact on registered plugins", async () => {
    canonical.__resetCapacitorForTests();
    const plugin = canonical.Capacitor.registerPlugin("Probe");
    const events: unknown[] = [];
    const listener = (event: unknown) => events.push(event);
    const handle = await plugin.addListener("state", listener);
    expect(typeof handle.remove).toBe("function");
    await plugin.removeAllListeners();
    expect(typeof plugin.removeListener).toBe("function");
    // removeListener is callable and settles.
    await plugin.removeListener("state", listener);
  });

  it("exposes the CapacitorHttp surface suites override per-case", () => {
    expect(typeof canonical.CapacitorHttp.get).toBe("function");
    expect(typeof canonical.CapacitorHttp.post).toBe("function");
    expect(typeof canonical.CapacitorHttp.request).toBe("function");
  });
});
