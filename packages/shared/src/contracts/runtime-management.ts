/** Cross-process contract for owner-approved Devices & Runtimes operations. */

export const RUNTIME_MANAGEMENT_OPERATIONS = [
  "list",
  "pair",
  "create_pairing",
  "claim_pairing",
  "confirm_pairing",
  "deny_pairing",
  "revoke",
  "remove",
  "retry",
  "inspect_ssh",
  "connect_ssh",
  "add_direct",
  "enroll_host",
  "approve_pairing",
  "start_host",
  "stop_host",
  "revoke_host",
] as const;

export type RuntimeManagementOperation =
  (typeof RUNTIME_MANAGEMENT_OPERATIONS)[number];

/**
 * Operations exempt from owner approval because they cannot mutate host state.
 * Single source of truth for the security partition consumers enforce:
 * the agent HTTP routes skip the proposal flow for these, and
 * plugin-app-control treats their complement as requiring explicit user
 * confirmation. Both views must be derived from this constant — a hand-written
 * duplicate in a consumer drifts silently when the shared operation list
 * changes (the plugin view updates by filter; the duplicate does not).
 */
export const RUNTIME_MANAGEMENT_OWNER_EXEMPT_OPERATIONS = [
  "list",
  "inspect_ssh",
] as const satisfies readonly RuntimeManagementOperation[];

export type RuntimeManagementOwnerExemptOperation =
  (typeof RUNTIME_MANAGEMENT_OWNER_EXEMPT_OPERATIONS)[number];

export interface RuntimeManagementRequest {
  op: RuntimeManagementOperation;
  targetId?: string;
  runtimeId?: string;
  label?: string;
  target?: string;
  sshPort?: number;
  remoteApiPort?: number;
  expectedFingerprint?: string;
  identityFile?: string;
  apiBase?: string;
  sessionId?: string;
  code?: string;
  /** One-use server proposal authority for an exact destructive request. */
  proposalId?: string;
  proposalNonce?: string;
  managedNetwork?: boolean;
  platform?: "macos" | "windows" | "linux";
}

export interface RuntimeManagementResult {
  ok: boolean;
  op: RuntimeManagementOperation;
  data?: Record<string, unknown>;
  error?: string;
}

export function isRuntimeManagementOperation(
  value: unknown,
): value is RuntimeManagementOperation {
  return (
    typeof value === "string" &&
    (RUNTIME_MANAGEMENT_OPERATIONS as readonly string[]).includes(value)
  );
}
