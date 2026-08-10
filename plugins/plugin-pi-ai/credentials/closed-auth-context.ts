/**
 * Prevents Pi from falling through to process or filesystem credentials.
 */
import type { AuthContext } from "@earendil-works/pi-ai";

export const CLOSED_PI_AUTH_CONTEXT: AuthContext = Object.freeze({
  async env(_name: string): Promise<undefined> {
    return undefined;
  },
  async fileExists(_path: string): Promise<false> {
    return false;
  },
});
