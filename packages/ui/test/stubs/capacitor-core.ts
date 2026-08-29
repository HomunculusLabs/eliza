/**
 * Canonical `@capacitor/core` test double for packages/ui suites. Every
 * `vi.mock("@capacitor/core", ...)` factory should compose this stub so the
 * mocked module keeps the runtime contract (notably `Capacitor.registerPlugin`,
 * which production modules such as platform/remote-controller.ts call at module
 * scope) even where a suite only cares about one method. Suites override the
 * members they exercise and leave the rest intact.
 *
 * `registerPlugin` mirrors the web runtime's plugin shape: a stable per-name
 * plugin object where event-listener methods work, and calling any other
 * method without an injected implementation rejects with a descriptive
 * "not implemented" error — the same failure the runtime produces — instead
 * of `undefined is not a function`.
 */

import { vi } from "vitest";

export interface CanonicalPluginListenerHandle {
  remove(): Promise<void>;
}

type CanonicalPluginListener = (event: unknown) => void;

interface CanonicalPluginBase {
  addListener(
    eventName: string,
    listener: CanonicalPluginListener,
  ): Promise<CanonicalPluginListenerHandle>;
  removeListener(
    eventName: string,
    listener: CanonicalPluginListener,
  ): Promise<void>;
  removeAllListeners(eventName?: string): Promise<void>;
}

export type CanonicalCapacitorPluginStub = CanonicalPluginBase & {
  // Delegate members may return anything; the runtime proxy does not
  // constrain method results either.
  [method: string]: (...args: never[]) => unknown;
};

const registeredPlugins = new Map<string, CanonicalCapacitorPluginStub>();

function notImplementedError(pluginName: string, methodName: string): Error {
  return new Error(
    `Capacitor plugin "${pluginName}" method "${methodName}" is not implemented in the canonical test stub (inject one with __setPluginForTests)`,
  );
}

function createPluginStub(name: string): CanonicalCapacitorPluginStub {
  const listeners = new Map<string, Set<CanonicalPluginListener>>();
  const base: CanonicalPluginBase = {
    async addListener(eventName, listener) {
      let set = listeners.get(eventName);
      if (!set) {
        set = new Set();
        listeners.set(eventName, set);
      }
      set.add(listener);
      return {
        async remove() {
          listeners.get(eventName)?.delete(listener);
        },
      };
    },
    async removeListener(eventName, listener) {
      listeners.get(eventName)?.delete(listener);
    },
    async removeAllListeners(eventName) {
      if (eventName === undefined) {
        listeners.clear();
        return;
      }
      listeners.delete(eventName);
    },
  };
  // Unknown methods still surface as callable (matching the runtime proxy
  // shape) and reject with a descriptive error when invoked without an
  // implementation.
  return new Proxy(base as CanonicalCapacitorPluginStub, {
    get(target, prop: string) {
      if (prop in target) {
        return target[prop as keyof CanonicalPluginBase];
      }
      return async (..._args: unknown[]) => {
        throw notImplementedError(name, prop);
      };
    },
  });
}

/** Runtime-shaped registerPlugin: returns a stable per-name plugin proxy. */
export function registerPlugin<T extends object = CanonicalCapacitorPluginStub>(
  name: string,
): T {
  const existing = registeredPlugins.get(name);
  if (existing) {
    return existing as T;
  }
  const plugin = createPluginStub(name);
  registeredPlugins.set(name, plugin);
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
