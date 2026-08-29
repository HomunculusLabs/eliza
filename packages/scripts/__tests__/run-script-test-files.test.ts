/** Verifies the isolated script-test runner argument bounds and failure attribution. */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseIsolatedScriptTestArgs } from "../run-script-test-files.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const driver = path.resolve(scriptDirectory, "..", "run-script-test-files.mjs");
const repoBunfig = path.resolve(
  scriptDirectory,
  "..",
  "bunfig.script-tests.toml",
);
const testFile = "packages/scripts/example.test.ts";

function parse(...options: string[]) {
  return parseIsolatedScriptTestArgs([...options, "--", testFile]);
}

describe("isolated script-test runner arguments", () => {
  test("preserves defaults and accepts the exact numeric ceilings", () => {
    expect(parse()).toMatchObject({ concurrency: 4, timeoutMs: 120_000 });
    expect(parse(`--concurrency=${Number.MAX_SAFE_INTEGER}`)).toMatchObject({
      concurrency: Number.MAX_SAFE_INTEGER,
    });
    expect(parse("--timeout-ms=2147483647")).toMatchObject({
      timeoutMs: 2_147_483_647,
    });
  });

  test.each(["0", "-1", "+1", "1.5", "1e3", "NaN", "Infinity", ""])(
    "rejects malformed positive integer %p",
    (value) => {
      expect(() => parse(`--concurrency=${value}`)).toThrow(
        "--concurrency requires a positive integer",
      );
      expect(() => parse(`--timeout-ms=${value}`)).toThrow(
        "--timeout-ms requires a positive integer",
      );
    },
  );

  test("rejects unsafe concurrency instead of rounding or accepting Infinity", () => {
    for (const value of ["9007199254740992", "9".repeat(400)]) {
      expect(() => parse(`--concurrency=${value}`)).toThrow(
        "--concurrency requires a positive safe integer",
      );
    }
  });

  test("rejects timeout values that Node would clamp to one millisecond", () => {
    for (const value of ["2147483648", "9007199254740992", "9".repeat(400)]) {
      expect(() => parse(`--timeout-ms=${value}`)).toThrow(
        "--timeout-ms requires a positive integer no greater than 2147483647",
      );
    }
  });

  test("the CLI rejects an overflowing timeout before starting a Bun child", () => {
    const result = spawnSync(
      process.execPath,
      [driver, "--timeout-ms=2147483648", "--", testFile],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "--timeout-ms requires a positive integer no greater than 2147483647",
    );
    expect(result.stderr).not.toContain("timed out");
    expect(result.stderr).not.toContain("TimeoutOverflowWarning");
  });

  test("the CLI names a failing test file", () => {
    const missingTestFile = "packages/scripts/__tests__/missing-script-test.ts";
    const result = spawnSync(
      process.execPath,
      [driver, "--concurrency=1", "--", missingTestFile],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `[script-tests] file=${missingTestFile} exitCode=1 signal=null`,
    );
  });
});

describe("isolated script-test runner failure attribution", () => {
  const repositories: string[] = [];

  afterEach(() => {
    for (const directory of repositories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function temporaryFixture(name: string, contents: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "script-driver-"));
    repositories.push(root);
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return { root, file };
  }

  function temporaryRepository(
    files: Array<{ name: string; contents: string }>,
  ) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "script-driver-"));
    repositories.push(root);
    for (const { name, contents } of files) {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    }
    return root;
  }

  test("a crashing child prints its file, exit code, and signal, and the lane fails", () => {
    const root = temporaryRepository([
      { name: "crash.test.ts", contents: "process.exit(23);\n" },
      {
        name: "passing.test.ts",
        contents:
          'import { expect, test } from "bun:test"; test("runs", () => expect(1).toBe(1));\n',
      },
    ]);
    const result = spawnSync(
      process.execPath,
      [
        driver,
        "--concurrency=1",
        `--config=${repoBunfig}`,
        "--",
        path.join(root, "crash.test.ts"),
        path.join(root, "passing.test.ts"),
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("1 of 2 script test file(s) failed");
    expect(result.stderr).toContain(
      `file=${path.join(root, "crash.test.ts")} exitCode=23 signal=null`,
    );
    expect(result.stderr).not.toContain(
      `file=${path.join(root, "passing.test.ts")}`,
    );
  });

  test("a signal-killed child prints the terminating signal instead of a bare exit code", () => {
    const fixture = temporaryFixture(
      "signal.test.ts",
      'process.kill(process.pid, "SIGKILL");\n',
    );
    const result = spawnSync(
      process.execPath,
      [
        driver,
        "--concurrency=1",
        `--config=${repoBunfig}`,
        "--",
        path.join(fixture.root, "signal.test.ts"),
      ],
      { cwd: fixture.root, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("1 of 1 script test file(s) failed");
    expect(result.stderr).toContain("exitCode=1");
    expect(result.stderr).toContain("signal=SIGKILL");
  });

  test("a spawn error prints the underlying cause alongside the file attribution", () => {
    const fixture = temporaryFixture(
      "needs-bun.test.ts",
      'import { expect, test } from "bun:test"; test("runs", () => expect(1).toBe(1));\n',
    );
    const emptyBin = path.join(fixture.root, "empty-bin");
    fs.mkdirSync(emptyBin, { recursive: true });
    const result = spawnSync(
      process.execPath,
      [
        driver,
        "--concurrency=1",
        `--config=${repoBunfig}`,
        "--",
        path.join(fixture.root, "needs-bun.test.ts"),
      ],
      {
        cwd: fixture.root,
        env: { ...process.env, PATH: emptyBin },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("1 of 1 script test file(s) failed");
    expect(result.stderr).toContain(
      `file=${path.join(fixture.root, "needs-bun.test.ts")} exitCode=1 signal=null`,
    );
    expect(result.stderr).toContain("error=");
    expect(result.stderr).toContain("Executable not found");
  });

  test("the per-file child receives the bunfig script-tests config before the test command", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "script-driver-argv-"));
    repositories.push(root);
    const bunDir = path.join(root, "bin");
    fs.mkdirSync(bunDir, { recursive: true });
    const fakeBun = path.join(bunDir, "bun");
    const argvLog = path.join(root, "argv.log");
    fs.writeFileSync(
      fakeBun,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvLog}"\nexit 0\n`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [
        driver,
        "--config=packages/scripts/bunfig.script-tests.toml",
        "--",
        testFile,
      ],
      {
        cwd: path.resolve(scriptDirectory, "..", "..", ".."),
        env: {
          ...process.env,
          PATH: `${bunDir}${path.delimiter}${process.env.PATH}`,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const argv = fs.readFileSync(argvLog, "utf8").split("\n").filter(Boolean);
    expect(argv[0]).toBe("--config=packages/scripts/bunfig.script-tests.toml");
    expect(argv[1]).toBe("test");
  });
});
