/**
 * Canonical `@capacitor/core` test double for packages/ui suites. Every
 * `vi.mock("@capacitor/core", ...)` factory should compose this stub so the
 * mocked module keeps the runtime contract (notably `Capacitor.registerPlugin`,
 * which production modules such as platform/remote-controller.ts call at module
 * scope) even where a suite only cares about one method. Suites override the
 * members they exercise and leave the rest intact.
 */

import { vi } from "vitest";

export interface CanonicalCapacitorPluginStub {
  [method: string]: (...args: unknown[]) => Promise<unknown>;
}

const registeredPlugins = new Map<string, CanonicalCapacitorPluginStub>();

/** Runtime-shaped registerPlugin: returns a stable per-name plugin proxy. */
export function registerPlugin<T extends object = CanonicalCapacitorPluginStub>(
  name: string,
): T {
  const existing = registeredPlugins.get(name);
  if (existing) {
    return existing as T;
  }
  const plugin: CanonicalCapacitorPluginStub = {};
  registeredPlugins.set(name, plugin as CanonicalCapacitorPluginStub);
  return plugin as T;
}

/** Test-only: replace the plugin registered under `name` (keeps identity stable for later registerPlugin callers). */
export function __setPluginForTests(
  name: string,
  plugin: CanonicalCapacitorPluginStub,
): void {
  registeredPlugins.set(name, plugin);
}

/** Test-only: drop all registered plugins between tests. */
export function __resetCapacitorForTests(): void {
  registeredPlugins.clear();
}

export const Capacitor = {
  getPlatform: () => "web",
  isNativePlatform: () => false,
  isPluginAvailable: (_name?: string) => false,
  registerPlugin,
};

export const CapacitorHttp = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  patch: vi.fn(),
  request: vi.fn(),
};
