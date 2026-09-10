/**
 * Direct owner-level coverage for the consolidated raw-SQL boundary:
 * literal encoders, strict row/result validation, JSON parsing, and the
 * optimistic-lock retry loop. Pure deterministic unit tests — `executeSql`
 * is exercised against a fake `RuntimeDb` while drizzle-orm's real `sql.raw`
 * builds the query object; no production helper is mocked.
 */

import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  asObject,
  executeSql,
  extractRows,
  OptimisticLockError,
  parseJsonArray,
  parseJsonRecord,
  parseJsonValue,
  RawSqlError,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
  toBoolean,
  toNumber,
  toText,
  withOptimisticRetry,
} from "./raw-sql.ts";

// ---------------------------------------------------------------------------
// asObject
// ---------------------------------------------------------------------------

describe("asObject", () => {
  it("returns null for null, undefined, primitives, and arrays", () => {
    expect(asObject(null)).toBeNull();
    expect(asObject(undefined)).toBeNull();
    expect(asObject(0)).toBeNull();
    expect(asObject("str")).toBeNull();
    expect(asObject([1, 2])).toBeNull();
  });

  it("returns the object itself for plain objects", () => {
    const value = { a: 1 };
    expect(asObject(value)).toBe(value);
  });
});

// ---------------------------------------------------------------------------
// toText / toNumber / toBoolean coercion tables
// ---------------------------------------------------------------------------

describe("toText", () => {
  it("returns strings unchanged and falls back for nullish", () => {
    expect(toText("x")).toBe("x");
    expect(toText("")).toBe("");
    expect(toText(null)).toBe("");
    expect(toText(null, "fb")).toBe("fb");
    expect(toText(undefined, "fb")).toBe("fb");
  });

  it("stringifies non-string primitives", () => {
    expect(toText(42)).toBe("42");
    expect(toText(true)).toBe("true");
  });
});

describe("toNumber", () => {
  it("accepts finite numbers and numeric strings, falls back otherwise", () => {
    expect(toNumber(7)).toBe(7);
    expect(toNumber("3.5")).toBe(3.5);
    expect(toNumber("nope")).toBe(0);
    expect(toNumber("nope", 9)).toBe(9);
    expect(toNumber(Number.NaN)).toBe(0);
    expect(toNumber(Number.POSITIVE_INFINITY, 1)).toBe(1);
  });
});

describe("toBoolean", () => {
  it("maps truthy/falsy string vocabularies case-insensitively", () => {
    for (const truthy of ["1", "true", "YES", " On "]) {
      expect(toBoolean(truthy)).toBe(true);
    }
    for (const falsy of ["0", "FALSE", "no", "off"]) {
      expect(toBoolean(falsy)).toBe(false);
    }
  });

  it("maps numbers by non-zero and falls back for unrecognized strings", () => {
    expect(toBoolean(1)).toBe(true);
    expect(toBoolean(0)).toBe(false);
    expect(toBoolean("maybe")).toBe(false);
    expect(toBoolean("maybe", true)).toBe(true);
    // The falsy vocabulary must win over a caller default of true.
    expect(toBoolean("0", true)).toBe(false);
    expect(toBoolean("off", true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SQL literal encoders
// ---------------------------------------------------------------------------

describe("sqlQuote", () => {
  it("wraps in single quotes and doubles embedded quotes", () => {
    expect(sqlQuote("plain")).toBe("'plain'");
    expect(sqlQuote("O'Brien")).toBe("'O''Brien'");
    expect(sqlQuote("a'b'c")).toBe("'a''b''c'");
  });

  it("round-trips through PostgreSQL single-quote unescaping rules", () => {
    // Simulate the driver-side unescape: '' -> '
    const pgUnescape = (literal: string) =>
      literal.slice(1, -1).replaceAll("''", "'");
    for (const original of ["plain", "it's", "''", "'", "a''b"]) {
      expect(pgUnescape(sqlQuote(original))).toBe(original);
    }
  });
});

describe("sqlText", () => {
  it("renders NULL for null/undefined and quotes strings", () => {
    expect(sqlText(null)).toBe("NULL");
    expect(sqlText(undefined)).toBe("NULL");
    expect(sqlText("v")).toBe("'v'");
    expect(sqlText("o'clock")).toBe("'o''clock'");
  });
});

describe("sqlInteger", () => {
  it("truncates floats and rejects non-finite values", () => {
    expect(sqlInteger(5)).toBe("5");
    expect(sqlInteger(5.9)).toBe("5");
    expect(sqlInteger(-3.9)).toBe("-3");
    expect(sqlInteger(null)).toBe("NULL");
    expect(() => sqlInteger(Number.NaN)).toThrow(RawSqlError);
    expect(() => sqlInteger(Number.POSITIVE_INFINITY)).toThrow(RawSqlError);
    try {
      sqlInteger(Number.NaN);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "SQL_VALUE_INVALID" });
    }
  });
});

describe("sqlNumber", () => {
  it("preserves fractional values and rejects non-finite ones", () => {
    expect(sqlNumber(1.25)).toBe("1.25");
    expect(sqlNumber(null)).toBe("NULL");
    expect(() => sqlNumber(Number.NaN)).toThrow(/numeric/);
  });
});

describe("sqlBoolean", () => {
  it("renders SQL boolean literals", () => {
    expect(sqlBoolean(true)).toBe("TRUE");
    expect(sqlBoolean(false)).toBe("FALSE");
  });
});

describe("sqlJson", () => {
  it("renders a quoted JSON literal with escaped quotes", () => {
    expect(sqlJson({ a: 1 })).toBe(`'{"a":1}'`);
    // JSON.stringify keeps the apostrophe; sqlQuote then doubles it.
    expect(sqlJson("it's")).toBe(`'"it''s"'`);
    expect(sqlJson(null)).toBe("'null'");
    expect(sqlJson(undefined)).toBe("'null'");
  });
});

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

describe("parseJsonValue", () => {
  it("returns the fallback for nullish and empty-string sentinels", () => {
    expect(parseJsonValue(null, "fb")).toBe("fb");
    expect(parseJsonValue(undefined, "fb")).toBe("fb");
    expect(parseJsonValue("", "fb")).toBe("fb");
  });

  it("passes objects through and parses JSON strings", () => {
    expect(parseJsonValue({ o: 1 }, "fb")).toEqual({ o: 1 });
    expect(parseJsonValue("[1,2]", "fb")).toEqual([1, 2]);
  });

  it("rejects malformed JSON strings and non-object non-string types", () => {
    expect(() => parseJsonValue("{oops", "fb")).toThrow(RawSqlError);
    try {
      parseJsonValue("{oops", "fb");
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "SQL_JSON_INVALID" });
    }
    expect(() => parseJsonValue(42, "fb")).toThrow(/Expected JSON string/);
  });
});

describe("parseJsonRecord", () => {
  it("returns {} for missing values and objects otherwise", () => {
    expect(parseJsonRecord(null)).toEqual({});
    expect(parseJsonRecord("")).toEqual({});
    expect(parseJsonRecord('{"k":"v"}')).toEqual({ k: "v" });
    expect(parseJsonRecord({ k: "v" })).toEqual({ k: "v" });
  });

  it("rejects non-object JSON payloads", () => {
    expect(() => parseJsonRecord("[1]")).toThrow(RawSqlError);
    expect(() => parseJsonRecord("42")).toThrow(/Expected SQL JSON object/);
    expect(() => parseJsonRecord("null")).toThrow(RawSqlError);
  });
});

describe("parseJsonArray", () => {
  it("returns [] for missing values and arrays otherwise", () => {
    expect(parseJsonArray(null)).toEqual([]);
    expect(parseJsonArray("[]")).toEqual([]);
    expect(parseJsonArray("[1,2]")).toEqual([1, 2]);
    expect(parseJsonArray([3])).toEqual([3]);
  });

  it("rejects non-array JSON payloads", () => {
    expect(() => parseJsonArray('{"a":1}')).toThrow(RawSqlError);
    expect(() => parseJsonArray("3")).toThrow(/Expected SQL JSON array/);
  });
});

// ---------------------------------------------------------------------------
// extractRows — strict result validation
// ---------------------------------------------------------------------------

describe("extractRows", () => {
  it("accepts a plain row array and unwraps PG-style envelopes", () => {
    expect(extractRows([{ id: 1 }])).toEqual([{ id: 1 }]);
    expect(extractRows({ rows: [{ id: 2 }] })).toEqual([{ id: 2 }]);
  });

  it("accepts empty envelopes (DDL) as empty row sets", () => {
    expect(extractRows([])).toEqual([]);
    expect(extractRows({ rows: [] })).toEqual([]);
    expect(extractRows({ command: "DDL", rows: [] })).toEqual([]);
  });

  it("rejects non-array results and non-envelope objects", () => {
    expect(() => extractRows(null)).toThrow(RawSqlError);
    expect(() => extractRows("nope")).toThrow(RawSqlError);
    expect(() => extractRows({ rowCount: 1 })).toThrow(/row array/);
    try {
      extractRows(42);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "SQL_RESULT_INVALID" });
    }
  });

  it("rejects a non-object row as a whole with its rowIndex context", () => {
    try {
      extractRows([{ ok: 1 }, "not a row"]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RawSqlError);
      expect(error).toMatchObject({
        code: "SQL_RESULT_INVALID",
        context: { rowIndex: 1 },
      });
    }
  });
});

// ---------------------------------------------------------------------------
// executeSql — delegation through the real drizzle sql.raw
// ---------------------------------------------------------------------------

describe("executeSql", () => {
  it("executes the raw statement and returns validated rows", async () => {
    let captured: SQL | undefined;
    const db = {
      async execute(query: SQL) {
        captured = query;
        return { rows: [{ n: 1 }] };
      },
    };
    const rows = await executeSql(db, "SELECT 1 AS n");
    expect(rows).toEqual([{ n: 1 }]);
    // The statement must actually flow through drizzle's sql.raw builder —
    // recover it from the SQL object's chunks, not from a passthrough string.
    expect(captured).toBeDefined();
    const chunks = (
      captured as unknown as { queryChunks?: Array<{ value?: unknown }> }
    ).queryChunks;
    const text = (chunks ?? [])
      .map((chunk) =>
        Array.isArray(chunk.value)
          ? chunk.value.join("")
          : String(chunk.value ?? ""),
      )
      .join("");
    expect(text).toContain("SELECT 1 AS n");
  });

  it("propagates strict validation failures from the adapter result", async () => {
    const db = {
      async execute() {
        return "not a result";
      },
    };
    await expect(executeSql(db, "SELECT 1")).rejects.toThrow(RawSqlError);
  });
});

// ---------------------------------------------------------------------------
// Optimistic-lock retry
// ---------------------------------------------------------------------------

describe("withOptimisticRetry", () => {
  it("retries only OptimisticLockError and succeeds once the conflict clears", async () => {
    const conflict = new OptimisticLockError({
      table: "t",
      id: "1",
      expectedVersion: 3,
    });
    let attempts = 0;
    const result = await withOptimisticRetry(
      () => {
        attempts += 1;
        if (attempts < 3) throw conflict;
        return Promise.resolve("done");
      },
      { baseDelayMs: 1 },
    );
    expect(result).toBe("done");
    expect(attempts).toBe(3);
  });

  it("rethrows non-conflict errors immediately without retrying", async () => {
    const boom = new Error("connection lost");
    let attempts = 0;
    await expect(
      withOptimisticRetry(
        () => {
          attempts += 1;
          return Promise.reject(boom);
        },
        { baseDelayMs: 1 },
      ),
    ).rejects.toBe(boom);
    expect(attempts).toBe(1);
  });

  it("exhausts attempts and rethrows the last conflict", async () => {
    const conflict = new OptimisticLockError({
      table: "t",
      id: "2",
      expectedVersion: 0,
    });
    let attempts = 0;
    await expect(
      withOptimisticRetry(
        () => {
          attempts += 1;
          throw conflict;
        },
        { maxAttempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toBe(conflict);
    expect(attempts).toBe(3);
  });

  it("uses exactly one attempt when maxAttempts is clamped below 1", async () => {
    let attempts = 0;
    const result = await withOptimisticRetry(
      () => {
        attempts += 1;
        return Promise.resolve(attempts);
      },
      { maxAttempts: 0 },
    );
    expect(result).toBe(1);
  });

  it("carries table/id/version context on the conflict error", () => {
    const error = new OptimisticLockError({
      table: "agents",
      id: "a1",
      expectedVersion: 7,
    });
    expect(error.table).toBe("agents");
    expect(error.id).toBe("a1");
    expect(error.expectedVersion).toBe(7);
    expect(error.message).toContain("agents");
    expect(error.message).toContain("expectedVersion=7");
  });
});
