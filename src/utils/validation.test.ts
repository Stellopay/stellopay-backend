import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  StarknetAddress,
  AgreementId,
  parsePagination,
  MAX_PAGE_LIMIT,
  DEFAULT_PAGE_LIMIT,
  loggedParse,
  formatValidationError,
  ValidationError,
  mapZodError,
  type ValidationErrorResponse,
} from "./validation";
import type { ValidationErrorMetric } from "./validation";

// --------------------------------------------------------------------------
// ValidationError
// --------------------------------------------------------------------------

describe("ValidationError", () => {
  it("captures validator name, message, and issues", () => {
    const err = new ValidationError({
      validator: "test",
      message: "something went wrong",
      issues: [{ path: ["name"], message: "too short", code: "too_small" }],
      input: "ab",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ValidationError");
    expect(err.validator).toBe("test");
    expect(err.message).toBe("something went wrong");
    expect(err.issues).toEqual([
      { path: ["name"], message: "too short", code: "too_small" },
    ]);
    expect(err.input).toBe("ab");
  });

  it("sets a default status of 400", () => {
    const err = new ValidationError({
      validator: "test",
      message: "fail",
      issues: [],
      input: "",
    });
    expect(err.status).toBe(400);
  });

  it("accepts an explicit status override", () => {
    const err = new ValidationError({
      validator: "test",
      message: "fail",
      issues: [],
      input: "",
      status: 422,
    });
    expect(err.status).toBe(422);
  });

  it("attaches the cause when provided", () => {
    const cause = new Error("root cause");
    const err = new ValidationError({
      validator: "test",
      message: "fail",
      issues: [],
      input: "",
      cause,
    });
    expect(err.cause).toBe(cause);
  });

  it("generates an ISO timestamp", () => {
    const err = new ValidationError({
      validator: "test",
      message: "fail",
      issues: [],
      input: "",
    });
    expect(Number.isNaN(Date.parse(err.timestamp))).toBe(false);
  });

  it("serializes to a plain JSON object via toJSON()", () => {
    const err = new ValidationError({
      validator: "vw",
      message: "invalid value",
      issues: [{ path: [], message: "invalid", code: "invalid_string" }],
      input: "bad",
    });
    const json = err.toJSON();
    expect(json).toMatchObject({
      name: "ValidationError",
      message: "invalid value",
      validator: "vw",
      issues: [{ path: [], message: "invalid", code: "invalid_string" }],
      input: "bad",
      status: 400,
    });
    expect(json).toHaveProperty("timestamp");
    expect(JSON.parse(JSON.stringify(err))).toMatchObject({
      name: "ValidationError",
      validator: "vw",
      issues: [{ path: [], message: "invalid", code: "invalid_string" }],
    });
  });

  it("round-trips through JSON.stringify without losing structure", () => {
    const err = new ValidationError({
      validator: "rt",
      message: "round trip",
      issues: [{ path: ["x"], message: "bad", code: "custom" }],
      input: "input",
    });
    const roundTripped = JSON.parse(JSON.stringify(err)) as Record<string, unknown>;
    expect(roundTripped.name).toBe("ValidationError");
    expect(roundTripped.validator).toBe("rt");
    expect(Array.isArray(roundTripped.issues)).toBe(true);
    expect(roundTripped.status).toBe(400);
  });

  it("fromZodError extracts issues, message, and cause from a ZodError", () => {
    const schema = z.string().min(5).email();
    const result = schema.safeParse("ab");
    expect(result.success).toBe(false);
    if (result.success) return;

    const err = ValidationError.fromZodError(result.error, "emailTest", "ab");
    expect(err.validator).toBe("emailTest");
    expect(err.input).toBe("ab");
    expect(err.message).toContain("Too small");
    expect(err.issues.length).toBeGreaterThanOrEqual(2);
    expect(err.issues[0]).toHaveProperty("path");
    expect(err.issues[0]).toHaveProperty("message");
    expect(err.issues[0]).toHaveProperty("code");
    expect(err.cause).toBe(result.error);
    expect(err.status).toBe(400);
  });
});

// --------------------------------------------------------------------------
// StarknetAddress
// --------------------------------------------------------------------------

describe("StarknetAddress", () => {
  it("accepts a 0x-prefixed hex address and returns the normalized form", () => {
    const out = StarknetAddress.parse(
      "0x04718f5a0Fc34cC1AF16A1cdee98fFB20C31f5cD61D6Ab07201858f4287c938D",
    );
    expect(out).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects a mixed-case address whose casing does not match the checksum", () => {
    expect(() =>
      StarknetAddress.parse("0x4718F5a0FC34Cc1AF16A1cdee98ffB20C31f5cd61d6ab07201858f4287c938d"),
    ).toThrow(/checksum/);
  });

  it("accepts an all-lowercase 64-hex-character address and normalizes it", () => {
    const address = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
    expect(StarknetAddress.parse(address)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("accepts a bare hex address without the 0x prefix and normalizes it", () => {
    expect(StarknetAddress.parse("abc")).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("accepts the shortest valid hex (1 digit, no prefix)", () => {
    expect(StarknetAddress.parse("1")).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("accepts a hex string padded to exactly 64 characters", () => {
    expect(StarknetAddress.parse(`0x${"a".repeat(64)}`)).toBe(`0x${"a".repeat(64)}`);
  });

  it("trims surrounding whitespace before validation", () => {
    expect(StarknetAddress.parse("  0x1  ")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(StarknetAddress.parse("\tabc\n")).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects a non-hex address", () => {
    expect(() => StarknetAddress.parse("0xnothexvalue")).toThrow();
    expect(() => StarknetAddress.parse("not-an-address")).toThrow();
  });

  it("rejects an address longer than 64 hex characters", () => {
    expect(() => StarknetAddress.parse(`0x${"a".repeat(65)}`)).toThrow();
  });

  it("rejects an extremely long hex string without a 0x prefix", () => {
    expect(() => StarknetAddress.parse("a".repeat(10_000))).toThrow(/hex/);
  });

  it("rejects an empty string", () => {
    expect(() => StarknetAddress.parse("")).toThrow();
  });

  it("rejects a whitespace-only string", () => {
    expect(() => StarknetAddress.parse("   ")).toThrow();
    expect(() => StarknetAddress.parse("\t\n")).toThrow();
  });

  it("rejects a '0x' prefix with no hex digits", () => {
    expect(() => StarknetAddress.parse("0x")).toThrow();
    expect(() => StarknetAddress.parse("0X")).toThrow();
  });

  it("rejects unicode that looks like hex digits", () => {
    expect(() => StarknetAddress.parse("0xＡＢＣ")).toThrow();
    expect(() => StarknetAddress.parse("٠١٢٣")).toThrow();
    expect(() => StarknetAddress.parse("०१२३")).toThrow();
  });

  it("rejects null and undefined inputs", () => {
    // @ts-expect-error: intentionally invalid input type
    expect(() => StarknetAddress.parse(null)).toThrow();
    // @ts-expect-error: intentionally invalid input type
    expect(() => StarknetAddress.parse(undefined)).toThrow();
  });

  it("rejects non-string inputs (number, object, array, boolean)", () => {
    // @ts-expect-error: intentionally invalid input type
    expect(() => StarknetAddress.parse(123)).toThrow();
    // @ts-expect-error: intentionally invalid input type
    expect(() => StarknetAddress.parse({})).toThrow();
    // @ts-expect-error: intentionally invalid input type
    expect(() => StarknetAddress.parse(["0x1"])).toThrow();
    // @ts-expect-error: intentionally invalid input type
    expect(() => StarknetAddress.parse(true)).toThrow();
  });
});

// --------------------------------------------------------------------------
// AgreementId
// --------------------------------------------------------------------------

describe("AgreementId", () => {
  it("accepts a numeric string", () => {
    expect(AgreementId.parse("42")).toBe("42");
  });

  it("accepts a numeric string with leading zeros", () => {
    expect(AgreementId.parse("00042")).toBe("00042");
  });

  it("accepts a very long numeric string", () => {
    const long = "1".repeat(10_000);
    expect(AgreementId.parse(long)).toBe(long);
  });

  it("accepts a single-digit id", () => {
    expect(AgreementId.parse("0")).toBe("0");
  });

  it("trims surrounding whitespace before validation", () => {
    expect(AgreementId.parse("  42  ")).toBe("42");
  });

  it("rejects a non-numeric id", () => {
    expect(() => AgreementId.parse("12ab")).toThrow();
    expect(() => AgreementId.parse("")).toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => AgreementId.parse("")).toThrow();
  });

  it("rejects a whitespace-only string", () => {
    expect(() => AgreementId.parse("   ")).toThrow();
  });

  it("rejects hex formatted as '0x...' (not a bare digit string)", () => {
    expect(() => AgreementId.parse("0x42")).toThrow();
    expect(() => AgreementId.parse("0x1")).toThrow();
  });

  it("rejects unicode digits that look numeric", () => {
    expect(() => AgreementId.parse("４２")).toThrow(); // fullwidth digits
    expect(() => AgreementId.parse("०१२")).toThrow(); // Devanagari digits
  });

  it("rejects negative numbers (no leading minus allowed)", () => {
    expect(() => AgreementId.parse("-1")).toThrow();
  });

  it("rejects floating-point strings", () => {
    expect(() => AgreementId.parse("1.5")).toThrow();
    expect(() => AgreementId.parse("1e5")).toThrow();
  });

  it("rejects null and undefined", () => {
    // @ts-expect-error: intentionally invalid input type
    expect(() => AgreementId.parse(null)).toThrow();
    // @ts-expect-error: intentionally invalid input type
    expect(() => AgreementId.parse(undefined)).toThrow();
  });

  it("rejects non-string inputs (number, object, array, boolean)", () => {
    // @ts-expect-error: intentionally invalid input type
    expect(() => AgreementId.parse(42)).toThrow();
    // @ts-expect-error: intentionally invalid input type
    expect(() => AgreementId.parse({})).toThrow();
    // @ts-expect-error: intentionally invalid input type
    expect(() => AgreementId.parse(["42"])).toThrow();
    // @ts-expect-error: intentionally invalid input type
    expect(() => AgreementId.parse(false)).toThrow();
  });
});

// --------------------------------------------------------------------------
// parsePagination
// --------------------------------------------------------------------------

describe("parsePagination", () => {
  it("uses defaults when params are missing", () => {
    expect(parsePagination({})).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
    expect(parsePagination(undefined)).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
    expect(parsePagination(null)).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
  });

  it("uses defaults when limit/offset are explicit null or empty strings", () => {
    expect(parsePagination({ limit: null, offset: null })).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
    expect(parsePagination({ limit: "", offset: "" })).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
    expect(parsePagination({ limit: null, offset: "" })).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
  });

  it("clamps an oversized limit down to the max", () => {
    expect(parsePagination({ limit: "5000" })).toEqual({
      limit: MAX_PAGE_LIMIT,
      offset: 0,
    });
  });

  it("falls back to defaults when the numeric string exceeds safe-integer range", () => {
    expect(parsePagination({ limit: "1e20" })).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
  });

  it("clamps a zero or negative limit up to 1", () => {
    expect(parsePagination({ limit: "0" }).limit).toBe(1);
    expect(parsePagination({ limit: "-9" }).limit).toBe(1);
  });

  it("accepts numeric (non-string) inputs by coercing via Zod", () => {
    expect(parsePagination({ limit: 10, offset: 20 })).toEqual({
      limit: 10,
      offset: 20,
    });
    expect(parsePagination({ limit: 1000 }).limit).toBe(MAX_PAGE_LIMIT);
    expect(parsePagination({ limit: 0 }).limit).toBe(1);
  });

  it("floors a negative offset to 0 and passes valid values through", () => {
    expect(parsePagination({ offset: "-3" }).offset).toBe(0);
    expect(parsePagination({ limit: "10", offset: "20" })).toEqual({
      limit: 10,
      offset: 20,
    });
    expect(parsePagination({ offset: -1 }).offset).toBe(0);
  });

  it("falls back to defaults for non-numeric values", () => {
    expect(parsePagination({ limit: "abc", offset: "xyz" })).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
  });

  it("falls back to defaults for non-integer (true float) numeric strings", () => {
    expect(parsePagination({ limit: "1.5" })).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
    expect(parsePagination({ limit: "0.1" })).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
  });

  it("treats scientific-notation and hex-prefixed integer strings as integers", () => {
    expect(parsePagination({ limit: "1e2" })).toEqual({
      limit: MAX_PAGE_LIMIT,
      offset: 0,
    });
    expect(parsePagination({ limit: "1.5e2" })).toEqual({
      limit: MAX_PAGE_LIMIT,
      offset: 0,
    });
    expect(parsePagination({ limit: "0x10" })).toEqual({
      limit: 16,
      offset: 0,
    });
  });

  it("accepts the exact boundary values 1 and MAX_PAGE_LIMIT without clamping", () => {
    expect(parsePagination({ limit: "1" })).toEqual({ limit: 1, offset: 0 });
    expect(parsePagination({ limit: String(MAX_PAGE_LIMIT) })).toEqual({
      limit: MAX_PAGE_LIMIT,
      offset: 0,
    });
  });

  it("accepts extremely large offset (no upper bound on offset, only >= 0)", () => {
    const huge = String(Number.MAX_SAFE_INTEGER);
    expect(parsePagination({ offset: huge }).offset).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("does not throw on array, object, or boolean query values", () => {
    expect(() => parsePagination({ limit: ["10"], offset: ["5"] })).not.toThrow();
    expect(parsePagination({ limit: ["10"], offset: ["5"] })).toEqual({
      limit: 10,
      offset: 5,
    });
    expect(parsePagination({ limit: ["10", "20"], offset: ["5", "6"] })).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
    expect(() => parsePagination({ limit: {}, offset: {} })).not.toThrow();
    expect(() => parsePagination({ limit: true, offset: false })).not.toThrow();
  });

  it("guards against Infinity and NaN limit values", () => {
    // Infinity string: Number("Infinity") === Infinity, which would pass
    // Zod's .int() check. guardFinite catches it and falls back.
    expect(parsePagination({ limit: "Infinity" }).limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(parsePagination({ limit: "NaN" }).limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(parsePagination({ limit: "-Infinity" }).limit).toBe(DEFAULT_PAGE_LIMIT);
  });

  it("guards against Infinity and NaN offset values", () => {
    expect(parsePagination({ offset: "Infinity" }).offset).toBe(0);
    expect(parsePagination({ offset: "NaN" }).offset).toBe(0);
    expect(parsePagination({ offset: "-Infinity" }).offset).toBe(0);
  });

  it("never throws regardless of input shape", () => {
    const calls = [
      () => parsePagination(undefined),
      () => parsePagination(null),
      () => parsePagination({}),
      () => parsePagination({ limit: "abc" }),
      () => parsePagination({ limit: "1.5" }),
      () => parsePagination({ limit: "" }),
      () => parsePagination({ limit: null }),
      () => parsePagination({ limit: -1 }),
      () => parsePagination({ limit: Number.MAX_SAFE_INTEGER }),
      () => parsePagination({ limit: Number.MIN_SAFE_INTEGER }),
      () => parsePagination({ offset: "" }),
      () => parsePagination({ offset: null }),
      () => parsePagination({ limit: "  10  " }),
      () => parsePagination({ limit: "Infinity" }),
      () => parsePagination({ limit: "NaN" }),
      () => parsePagination({ offset: "Infinity" }),
      () => parsePagination({ offset: "NaN" }),
    ];
    for (const c of calls) {
      expect(c).not.toThrow();
      const out = c();
      expect(typeof out.limit).toBe("number");
      expect(typeof out.offset).toBe("number");
      expect(Number.isFinite(out.limit)).toBe(true);
      expect(Number.isFinite(out.offset)).toBe(true);
      expect(out.limit).toBeGreaterThanOrEqual(1);
      expect(out.limit).toBeLessThanOrEqual(MAX_PAGE_LIMIT);
      expect(out.offset).toBeGreaterThanOrEqual(0);
    }
  });

  it("trims whitespace from numeric string values", () => {
    expect(parsePagination({ limit: "  10  " })).toEqual({ limit: 10, offset: 0 });
  });
});

// --------------------------------------------------------------------------
// loggedParse
// --------------------------------------------------------------------------

describe("loggedParse", () => {
  it("returns the parsed value on success", () => {
    const schema = z.string().min(1);
    const result = loggedParse(schema, "hello", "testSchema");
    expect(result).toBe("hello");
  });

  it("logs and throws a ValidationError on validation failure", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = z.string().min(1);
    expect(() => loggedParse(schema, "", "testSchema")).toThrow(ValidationError);
    try {
      loggedParse(schema, "", "testSchema");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).validator).toBe("testSchema");
      expect((e as ValidationError).status).toBe(400);
    }
    expect(warn).toHaveBeenCalled();
    const call = warn.mock.calls[0][0] as string;
    expect(call).toContain("[validation:error]");
    expect(call).toContain("testSchema");
    warn.mockRestore();
  });

  it("includes a truncated input preview in the log payload (max 40 chars)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = z.string().min(1).max(50);
    const long = "a".repeat(200);
    expect(() => loggedParse(schema, long, "longerSchema")).toThrow(ValidationError);
    const call = warn.mock.calls[0][0] as string;
    const truncated = long.slice(0, 40);
    expect(call).toContain(truncated);
    expect(call).not.toContain(long);
    warn.mockRestore();
  });

  it("stringifies non-string input via String() before logging", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => loggedParse(z.string().min(1), 12345, "numInput")).toThrow(ValidationError);
    const call = warn.mock.calls[0][0] as string;
    expect(call).toContain("numInput");
    expect(call).toContain("12345");
    warn.mockRestore();
  });

  it("emits a JSON-formatted log with validator / input / error / timestamp", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = z.string().min(1);
    expect(() => loggedParse(schema, "", "abc")).toThrow(ValidationError);
    const raw = warn.mock.calls[0][0] as string;
    const json = raw.replace("[validation:error] ", "");
    const parsed: unknown = JSON.parse(json);
    expect(parsed).toMatchObject({
      validator: "abc",
      input: "",
      error: expect.any(String),
      timestamp: expect.any(String),
    });
    const ts = (parsed as { timestamp: string }).timestamp;
    expect(Number.isNaN(Date.parse(ts))).toBe(false);
    expect(Math.abs(Date.now() - Date.parse(ts))).toBeLessThan(60_000);
    warn.mockRestore();
  });

  it("joins multiple issue messages with '; '", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = z.string().min(5).email();
    expect(() => loggedParse(schema, "ab", "joined")).toThrow(ValidationError);
    const raw = warn.mock.calls[0][0] as string;
    const json = raw.replace("[validation:error] ", "");
    const parsed = JSON.parse(json) as { error: string };
    expect(parsed.error.split("; ").length).toBeGreaterThanOrEqual(2);
    warn.mockRestore();
  });

  it("does not log on the success path", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = z.string().min(1);
    loggedParse(schema, "ok", "silentOnSuccess");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // -------------------------------------------------------------------------
  // ValidationError — thrown type contract
  // -------------------------------------------------------------------------

  it("throws a ValidationError (not a plain Error) on failure", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = z.string().min(1);
    let caught: unknown;
    try {
      loggedParse(schema, "", "typeCheck");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    vi.restoreAllMocks();
  });

  it("ValidationError carries the ZodError as .cause", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = z.string().min(1);
    let caught: unknown;
    try {
      loggedParse(schema, "", "causeCheck");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const err = caught as ValidationError;
    expect(err.cause).toBeInstanceOf(z.ZodError);
    vi.restoreAllMocks();
  });

  it("ValidationError.metric matches the ValidationErrorMetric shape", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = z.string().min(1);
    let caught: unknown;
    try {
      loggedParse(schema, "", "metricShape");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const metric: ValidationErrorMetric = (caught as ValidationError).metric;
    expect(typeof metric.validator).toBe("string");
    expect(typeof metric.input).toBe("string");
    expect(typeof metric.error).toBe("string");
    expect(typeof metric.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(metric.timestamp))).toBe(false);
    vi.restoreAllMocks();
  });

  it("ValidationError.metric.validator equals the validatorName argument", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = z.string().min(1);
    let caught: unknown;
    try {
      loggedParse(schema, "", "myValidator");
    } catch (e) {
      caught = e;
    }
    expect((caught as ValidationError).metric.validator).toBe("myValidator");
    vi.restoreAllMocks();
  });

  it("ValidationError.name is 'ValidationError'", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = z.string().min(1);
    let caught: unknown;
    try {
      loggedParse(schema, "", "nameCheck");
    } catch (e) {
      caught = e;
    }
    expect((caught as ValidationError).name).toBe("ValidationError");
    vi.restoreAllMocks();
  });

  it("ValidationError.message equals the joined Zod issue messages", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = z.string().min(5).email();
    let caught: unknown;
    try {
      loggedParse(schema, "ab", "msgCheck");
    } catch (e) {
      caught = e;
    }
    const err = caught as ValidationError;
    // message must be the same '; '-joined string stored in metric.error
    expect(err.message).toBe(err.metric.error);
    vi.restoreAllMocks();
  });
});

// --------------------------------------------------------------------------
// parsePagination — non-object top-level input (isPlainObject guard)
// --------------------------------------------------------------------------

describe("parsePagination — non-object top-level input", () => {
  // These inputs were previously cast silently via `(query ?? {}) as
  // Record<string, unknown>`. The isPlainObject guard now makes the intent
  // explicit: any non-plain-object falls back to an empty object, so limit
  // and offset both resolve to their documented defaults.

  it("returns defaults for a top-level string input", () => {
    expect(parsePagination("limit=10&offset=5")).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
  });

  it("returns defaults for a top-level number input", () => {
    expect(parsePagination(42)).toEqual({ limit: DEFAULT_PAGE_LIMIT, offset: 0 });
    expect(parsePagination(0)).toEqual({ limit: DEFAULT_PAGE_LIMIT, offset: 0 });
  });

  it("returns defaults for a top-level array input", () => {
    // Arrays are objects in JS but not plain objects — they carry no
    // limit/offset keys and must not be indexed as if they did.
    expect(parsePagination([{ limit: "10" }])).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
    expect(parsePagination(["10", "5"])).toEqual({ limit: DEFAULT_PAGE_LIMIT, offset: 0 });
  });

  it("returns defaults for a top-level boolean input", () => {
    expect(parsePagination(true)).toEqual({ limit: DEFAULT_PAGE_LIMIT, offset: 0 });
    expect(parsePagination(false)).toEqual({ limit: DEFAULT_PAGE_LIMIT, offset: 0 });
  });

  it("does not throw for any non-object top-level input", () => {
    const nonObjects = ["string", 42, 0, -1, true, false, [], [1, 2], Symbol("x")];
    for (const val of nonObjects) {
      expect(() => parsePagination(val)).not.toThrow();
      const out = parsePagination(val);
      expect(out.limit).toBeGreaterThanOrEqual(1);
      expect(out.limit).toBeLessThanOrEqual(MAX_PAGE_LIMIT);
      expect(out.offset).toBeGreaterThanOrEqual(0);
    }
  });
});

// --------------------------------------------------------------------------
// formatValidationError
// --------------------------------------------------------------------------

describe("formatValidationError", () => {
  it("returns 'Validation failed' with Zod issues for a ZodError", () => {
    const raw = "not-a-number";
    try {
      z.number().parse(raw);
    } catch (e) {
      const result = formatValidationError(e);
      expect(result).toMatchObject<ValidationErrorResponse>({
        error: "Validation failed",
        details: expect.any(Array),
      });
      expect(result.details?.length).toBeGreaterThanOrEqual(1);
      expect(result.details![0]).toHaveProperty("message");
      expect(result.details![0]).toHaveProperty("code");
    }
  });

  it("returns 'Invalid request' without details for a non-Zod error", () => {
    const result = formatValidationError(new Error("something broke"));
    expect(result).toEqual<ValidationErrorResponse>({
      error: "Invalid request",
    });
    expect(result.details).toBeUndefined();
  });

  it("returns 'Invalid request' without details for a plain string", () => {
    const result = formatValidationError("unexpected string error");
    expect(result).toEqual<ValidationErrorResponse>({
      error: "Invalid request",
    });
  });

  it("returns 'Invalid request' without details for null / undefined input", () => {
    expect(formatValidationError(null)).toEqual<ValidationErrorResponse>({
      error: "Invalid request",
    });
    expect(formatValidationError(undefined)).toEqual<ValidationErrorResponse>({
      error: "Invalid request",
    });
  });

  it("returns 'Invalid request' without details for an object that is not a ZodError", () => {
    const result = formatValidationError({ custom: true });
    expect(result).toEqual<ValidationErrorResponse>({
      error: "Invalid request",
    });
  });

  it("preserves the original Zod issue shape in details", () => {
    const schema = z.object({
      name: z.string().min(1, "name is required"),
      age: z.number().int().positive(),
    });
    try {
      schema.parse({ name: "", age: -1 });
    } catch (e) {
      const result = formatValidationError(e);
      expect(result.error).toBe("Validation failed");
      expect(result.details).toHaveLength(2);
      expect(result.details![0].path).toEqual(["name"]);
      expect(result.details![1].path).toEqual(["age"]);
    }
  });
});

// ---- mapZodError ----

describe("mapZodError", () => {
  it("returns custom code for checksum fail",()=>{
    try{
      StarknetAddress.parse("0x4718F5a0FC34Cc1AF16A1cdee98ffB20C31f5cd61d6ab07201858f4287c938d");
    } catch (e) {
      const mapped = mapZodError(e);
      expect(mapped).toBeDefined();
      expect(mapped!.code).toBe("custom");
      expect(mapped!.message).toContain("checksum");
      expect(mapped!.path).toEqual([]);
    }
  });
  it("returns invalid_string for AgreementId", () => {
    try {
      AgreementId.parse("abc");
    } catch (e) {
      const mapped = mapZodError(e);
      expect(mapped).toBeDefined();
      expect(mapped!.code).toBe("invalid_format");
      expect(mapped!.message).toContain("numeric");
      expect(mapped!.path).toEqual([]);
    }
  });
  it("returns undefined for non-ZodError", () => {
    const mapped = mapZodError(new Error("boom"));
    expect(mapped).toBeUndefined();
  });
});
