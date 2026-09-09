/**
 * Unit tests for the Verify Chunk Safety app shell contract and coverage
 * guardrail.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The gate script reads `${cwd}/dist/assets/*.js` and exits non-zero when the
// bn.js crypto marker (`toArrayLike`) lands in a chunk that is NOT one of the
// lazy `vendor-(crypto|solana|wallet)-` chunks. We exercise it as a subprocess
// against synthetic `dist/assets` fixtures so the regression guard is itself
// tested — the #9150 fold (crypto graph folded into the eager date-fns `en_US`
// locale chunk) MUST fail the gate, and a clean lazy layout MUST pass.

const GATE_SCRIPT = join(
  import.meta.dirname,
  "..",
  "scripts",
  "verify-chunk-safety.mjs",
);

const CRYPTO_MARKER = "toArrayLike";

let workDir: string;

function writeChunk(name: string, contents: string): void {
  writeFileSync(join(workDir, "dist", "assets", name), contents, "utf8");
}

function runGate(): { status: number; output: string } {
  try {
    const stdout = execFileSync("node", [GATE_SCRIPT], {
      cwd: workDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? 1,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "chunk-safety-"));
  mkdirSync(join(workDir, "dist", "assets"), { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("verify-chunk-safety gate", () => {
  it("FAILS when the bn.js crypto graph leaks into an eager locale chunk (#9150)", () => {
    // Reproduces the real regression: the crypto marker folded into the eager
    // date-fns `en_US` i18n locale chunk instead of a lazy vendor chunk.
    writeChunk(
      "en_US-SK3WV2N3-B4WdXTLq.js",
      `function bn(){return ${CRYPTO_MARKER}}`,
    );
    writeChunk("index-BEExhTUo.js", "export const ok = 1;");

    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain("FAIL");
    expect(output).toContain("en_US-SK3WV2N3-B4WdXTLq.js");
  });

  it("FAILS when the crypto graph leaks into the eager entry chunk", () => {
    writeChunk("index-BEExhTUo.js", `function bn(){return ${CRYPTO_MARKER}}`);

    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain("index-BEExhTUo.js");
  });

  it("PASSES when the crypto graph is confined to a lazy vendor-crypto chunk", () => {
    writeChunk(
      "vendor-crypto-DRnRpPYP.js",
      `function bn(){return ${CRYPTO_MARKER}}`,
    );
    writeChunk("en_US-SK3WV2N3-g943u0fV.js", "export const locale = {};");
    writeChunk("index-D9yqvBmw.js", "export const app = 1;");

    const { status, output } = runGate();
    expect(status).toBe(0);
    expect(output).toContain("OK");
  });

  it("PASSES when the crypto marker is absent entirely", () => {
    writeChunk("index-D9yqvBmw.js", "export const app = 1;");

    const { status, output } = runGate();
    expect(status).toBe(0);
    expect(output).toContain("OK");
  });
});

// The eagerness guard walks the entry's STATIC import closure from the
// index.html module script; a confined-but-eager vendor-crypto (the #13187
// manual-chunk fold: a pinned first-party module drags the shared core/UI
// graph into vendor-crypto, so the entry statically imports the multi-MB
// chunk at boot) must fail even though confinement passes.
describe("verify-chunk-safety eagerness guard", () => {
  function writeIndexHtml(entryFile: string): void {
    writeFileSync(
      join(workDir, "dist", "index.html"),
      `<!doctype html><html><head><script type="module" crossorigin src="/assets/${entryFile}"></script></head><body></body></html>`,
      "utf8",
    );
  }

  it("FAILS when the entry statically imports vendor-crypto", () => {
    writeChunk(
      "index-D9yqvBmw.js",
      'import{a}from"./vendor-crypto-DRnRpPYP.js";export const app=a;',
    );
    writeChunk(
      "vendor-crypto-DRnRpPYP.js",
      `export const a=1;function bn(){return ${CRYPTO_MARKER}}`,
    );
    writeIndexHtml("index-D9yqvBmw.js");

    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain("STATIC import closure");
    expect(output).toContain("vendor-crypto-DRnRpPYP.js");
  });

  it("FAILS when vendor-crypto is reached transitively through an eager sibling chunk", () => {
    writeChunk(
      "index-D9yqvBmw.js",
      'import{s}from"./shared-Cabc1234.js";export const app=s;',
    );
    writeChunk(
      "shared-Cabc1234.js",
      'export{a as s}from"./vendor-crypto-DRnRpPYP.js";',
    );
    writeChunk(
      "vendor-crypto-DRnRpPYP.js",
      `export const a=1;function bn(){return ${CRYPTO_MARKER}}`,
    );
    writeIndexHtml("index-D9yqvBmw.js");

    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain("vendor-crypto-DRnRpPYP.js");
  });

  it("PASSES when vendor-crypto is only reachable through a dynamic import()", () => {
    writeChunk(
      "index-D9yqvBmw.js",
      'export const load=()=>import("./vendor-crypto-DRnRpPYP.js");',
    );
    writeChunk(
      "vendor-crypto-DRnRpPYP.js",
      `export const a=1;function bn(){return ${CRYPTO_MARKER}}`,
    );
    writeIndexHtml("index-D9yqvBmw.js");

    const { status, output } = runGate();
    expect(status).toBe(0);
    expect(output).toContain("entry static closure");
  });
});

// The renderer-entry guard (#30873): src/entry.ts dispatches to the real
// renderer via dynamic import(), so the HTML entry closure walk above cannot
// see the renderer's static graph. A renderer entry (named like
// main-*.js / marketing-home-entry-*.js, or any other dynamic target of the
// dispatcher chunk) that statically imports a lazy-by-design vendor chunk
// must fail the gate even though the HTML entry itself stays clean.
describe("verify-chunk-safety renderer-entry guard", () => {
  function writeIndexHtml(entryFile: string): void {
    writeFileSync(
      join(workDir, "dist", "index.html"),
      `<!doctype html><html><head><script type="module" crossorigin src="/assets/${entryFile}"></script></head><body></body></html>`,
      "utf8",
    );
  }

  it("FAILS when a dynamically-dispatched renderer entry statically imports vendor-crypto", () => {
    // The dispatcher itself is clean: it only dynamically imports the app
    // renderer entry, exactly like src/entry.ts does for import("./main").
    writeChunk(
      "index-CaYYxr8D.js",
      'export const boot=()=>import("./index-DOWjB3rp.js");',
    );
    // The renderer entry statically imports the crypto chunk for a shared
    // boot leaf (the #30873 shape: clsx/RemoveScroll/bs58 folded into vc).
    writeChunk(
      "index-DOWjB3rp.js",
      'import{clsx}from"./vendor-crypto-DRnRpPYP.js";export const app=clsx;',
    );
    writeChunk(
      "vendor-crypto-DRnRpPYP.js",
      `export const clsx=1;function bn(){return ${CRYPTO_MARKER}}`,
    );
    writeIndexHtml("index-CaYYxr8D.js");

    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain("renderer entry index-DOWjB3rp.js");
    expect(output).toContain("vendor-crypto-DRnRpPYP.js");
  });

  it("FAILS when a named renderer entry (marketing-home-entry) statically imports vendor-crypto", () => {
    writeChunk(
      "index-CaYYxr8D.js",
      'export const boot=()=>import("./marketing-home-entry-B1YssIhr.js");',
    );
    writeChunk(
      "marketing-home-entry-B1YssIhr.js",
      'import{x}from"./vendor-crypto-DRnRpPYP.js";export const page=x;',
    );
    writeChunk(
      "vendor-crypto-DRnRpPYP.js",
      `export const x=1;function bn(){return ${CRYPTO_MARKER}}`,
    );
    writeIndexHtml("index-CaYYxr8D.js");

    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain("marketing-home-entry-B1YssIhr.js");
  });

  it("PASSES when the renderer entry keeps vendor-crypto behind a further dynamic import()", () => {
    writeChunk(
      "index-CaYYxr8D.js",
      'export const boot=()=>import("./index-DOWjB3rp.js");',
    );
    writeChunk(
      "index-DOWjB3rp.js",
      'export const loadWallet=()=>import("./vendor-crypto-DRnRpPYP.js");export const app=1;',
    );
    writeChunk(
      "vendor-crypto-DRnRpPYP.js",
      `export const a=1;function bn(){return ${CRYPTO_MARKER}}`,
    );
    writeIndexHtml("index-CaYYxr8D.js");

    const { status, output } = runGate();
    expect(status).toBe(0);
    expect(output).toContain("renderer entry index-DOWjB3rp.js");
  });
});
