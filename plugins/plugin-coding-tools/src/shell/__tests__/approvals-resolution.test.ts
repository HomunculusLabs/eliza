/**
 * Pins the exec-approvals config-resolution layer: normalizeApprovals
 * default-agent handling, resolveApprovalsFromFile precedence
 * (agent > wildcard > defaults > EXEC_APPROVAL_DEFAULTS), invalid-value
 * fail-safe fallbacks, and matchAllowlist pattern semantics. These gate every
 * SHELL execution through ExecApprovalService. Deterministic harness — no
 * filesystem, no processes.
 */

import { describe, expect, it } from "vitest";

import {
  matchAllowlist,
  normalizeApprovals,
  resolveApprovalsFromFile,
} from "../approvals/allowlist";
import type {
  CommandResolution,
  ExecAllowlistEntry,
  ExecApprovalsFile,
} from "../approvals/types";

function resolution(path: string): CommandResolution {
  return { resolvedPath: path } as CommandResolution;
}

describe("normalizeApprovals", () => {
  it("preserves an explicit agents.default config (the canonical default-agent key)", () => {
    const file = normalizeApprovals({
      version: 1,
      agents: {
        default: {
          security: "full",
          allowlist: [{ pattern: "/usr/bin/git" }],
        },
        alice: { security: "deny" },
      },
    } as ExecApprovalsFile);

    expect(file.agents?.default).toEqual({
      security: "full",
      allowlist: [expect.objectContaining({ pattern: "/usr/bin/git" })],
    });
    expect(file.agents?.alice).toEqual({ security: "deny" });
  });

  it("preserves distinct entries whose patterns differ only in case", () => {
    // A dedup self-merge inside normalize would silently drop the second
    // entry, and ensureApprovals persists the loss back to disk.
    const file = normalizeApprovals({
      version: 1,
      agents: {
        default: {
          security: "allowlist",
          allowlist: [
            {
              id: "first",
              pattern: "/usr/bin/git",
              lastUsedCommand: "git status",
            },
            {
              id: "second",
              pattern: "/USR/BIN/GIT",
              lastUsedCommand: "git fetch",
            },
          ],
        },
      },
    } as ExecApprovalsFile);

    expect(file.agents?.default?.allowlist).toEqual([
      { id: "first", pattern: "/usr/bin/git", lastUsedCommand: "git status" },
      { id: "second", pattern: "/USR/BIN/GIT", lastUsedCommand: "git fetch" },
    ]);
  });

  it("is idempotent on an already-normalized file", () => {
    const once = normalizeApprovals({
      version: 1,
      agents: {
        default: {
          security: "allowlist",
          allowlist: [{ pattern: "/usr/bin/git" }],
        },
      },
    } as ExecApprovalsFile);
    const twice = normalizeApprovals(once);

    expect(twice.agents?.default?.security).toBe("allowlist");
    expect(twice.agents?.default?.allowlist).toEqual(
      once.agents?.default?.allowlist,
    );
  });

  it("round-trips a default-agent allowlist entry through resolveApprovalsFromFile", () => {
    const file = normalizeApprovals({
      version: 1,
      agents: {
        default: {
          security: "allowlist",
          allowlist: [{ pattern: "/usr/local/bin/deploy.sh" }],
        },
      },
    } as ExecApprovalsFile);

    const resolved = resolveApprovalsFromFile({ file, agentId: undefined });
    expect(resolved.agent.security).toBe("allowlist");
    expect(resolved.allowlist.map((entry) => entry.pattern)).toEqual([
      "/usr/local/bin/deploy.sh",
    ]);
  });

  it("backfills missing allowlist entry ids without dropping entries", () => {
    const file = normalizeApprovals({
      version: 1,
      agents: {
        default: {
          allowlist: [
            { pattern: "/usr/bin/git" },
            { id: "stable-id", pattern: "/usr/bin/rg" },
          ],
        },
      },
    } as ExecApprovalsFile);

    const allowlist = file.agents?.default?.allowlist ?? [];
    expect(allowlist).toHaveLength(2);
    expect(typeof allowlist[0]?.id).toBe("string");
    expect(allowlist[0]?.id?.length).toBeGreaterThan(0);
    expect(allowlist[0]?.id).not.toBe(allowlist[1]?.id);
    expect(allowlist[1]?.id).toBe("stable-id");
  });

  it("keeps empty agents and trims socket fields to undefined", () => {
    const file = normalizeApprovals({
      version: 1,
      socket: { path: "  ", token: "tok" },
      agents: {},
    } as ExecApprovalsFile);

    expect(file.version).toBe(1);
    expect(file.socket).toEqual({ path: undefined, token: "tok" });
    expect(file.agents).toEqual({});
  });
});

describe("resolveApprovalsFromFile precedence", () => {
  const file: ExecApprovalsFile = {
    version: 1,
    defaults: { security: "deny", ask: "off" },
    agents: {
      "*": {
        security: "allowlist",
        ask: "on-miss",
        allowlist: [{ pattern: "/usr/bin/git" }],
      },
      alice: { ask: "always" },
    },
  };

  it("agent beats wildcard, wildcard beats defaults", () => {
    const alice = resolveApprovalsFromFile({ file, agentId: "alice" });
    expect(alice.agent.security).toBe("allowlist"); // from wildcard
    expect(alice.agent.ask).toBe("always"); // agent beats wildcard
    expect(alice.allowlist.map((entry) => entry.pattern)).toEqual([
      "/usr/bin/git",
    ]); // wildcard allowlist inherited

    const bob = resolveApprovalsFromFile({ file, agentId: "bob" });
    expect(bob.agent.security).toBe("allowlist"); // wildcard
    expect(bob.agent.ask).toBe("on-miss"); // wildcard
  });

  it("an agent without wildcard/defaults falls back to fail-closed shipped defaults", () => {
    const resolved = resolveApprovalsFromFile({
      file: { version: 1, agents: {} },
      agentId: "carol",
    });
    expect(resolved.agent).toEqual({
      security: "deny",
      ask: "on-miss",
      askFallback: "deny",
      autoAllowSkills: false,
    });
  });

  it("invalid security/ask values fail safe instead of passing through", () => {
    const resolved = resolveApprovalsFromFile({
      file: {
        version: 1,
        defaults: { security: "yolo" as never, ask: "sometimes" as never },
        agents: {},
      },
      agentId: "dave",
    });
    expect(resolved.agent.security).toBe("deny");
    expect(resolved.agent.ask).toBe("on-miss");
  });
});

describe("matchAllowlist pattern semantics", () => {
  const entries: ExecAllowlistEntry[] = [
    { pattern: "git" }, // bare name: never a match (path required)
    { pattern: "/usr/bin/git" },
    { pattern: "/opt/tools/*.sh" },
  ];

  it("excludes bare-name patterns and matches exact paths", () => {
    // "git" precedes "/usr/bin/git" in the list; a bare-name bug would
    // wrongly return the bare entry (allowing every resolved binary that
    // string-matches the pattern anywhere).
    expect(matchAllowlist(entries, resolution("/usr/bin/git"))?.pattern).toBe(
      "/usr/bin/git",
    );
  });

  it("single * stays within one path segment; ** crosses directories", () => {
    expect(
      matchAllowlist(entries, resolution("/opt/tools/run.sh"))?.pattern,
    ).toBe("/opt/tools/*.sh");
    expect(matchAllowlist(entries, resolution("/opt/bin/run.sh"))).toBeNull();

    expect(
      matchAllowlist([{ pattern: "/opt/**/tool" }], resolution("/opt/a/b/tool"))
        ?.pattern,
    ).toBe("/opt/**/tool");
    expect(
      matchAllowlist([{ pattern: "/opt/*/tool" }], resolution("/opt/a/b/tool")),
    ).toBeNull();
  });

  it("skips blank patterns and never matches without a resolved path", () => {
    expect(
      matchAllowlist([{ pattern: "   " }], resolution("/usr/bin/git")),
    ).toBeNull();
    expect(matchAllowlist(entries, null)).toBeNull();
    expect(matchAllowlist([], resolution("/usr/bin/git"))).toBeNull();
  });

  it("matches paths case-insensitively", () => {
    expect(
      matchAllowlist([{ pattern: "/USR/BIN/GIT" }], resolution("/usr/bin/git"))
        ?.pattern,
    ).toBe("/USR/BIN/GIT");
  });
});
