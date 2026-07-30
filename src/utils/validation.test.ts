import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  StarknetAddress,
  AgreementId,
  IdempotencyKeySchema,
  parsePagination,
  MAX_PAGE_LIMIT,
  DEFAULT_PAGE_LIMIT,
  INPUT_PREVIEW_MAX_LENGTH,
  loggedParse,
  formatValidationError,
  isPlainObject,
  isValidationError,
  previewInput,
  ValidationError,
  mapZodError,
  CurrencyCodeSchema,
  createBillingAmountSchema,
  BillingAmountSchema,
  validateBillingInput,
  validateBillingRequest,
  SUPPORTED_CURRENCIES,
  type ValidationErrorResponse,
  type ValidationIssue,
} from "./validation";
import type { ValidationErrorMetric } from "./validation";

describe("IdempotencyKeySchema", () => {
  it("accepts bounded ASCII keys", () => {
    expect(IdempotencyKeySchema.parse("checkout_2026-07-30")).toBe("checkout_2026-07-30");
    expect(IdempotencyKeySchema.parse("a".repeat(255))).toHaveLength(255);
  });

  it.each(["", " ", "key with spaces", "key/slash", "a".repeat(256)])(
    "rejects unsafe key %j",
    (value) => {
      expect(IdempotencyKeySchema.safeParse(value).success).toBe(false);
    },
  );
});

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
    expect(err.issues).toEqual([{ path: ["name"], message: "too short", code: "too_small" }]);
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
  it("returns custom code for checksum fail", () => {
    try {
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

  it("returns the first issue of a ValidationError", () => {
    const err = new ValidationError({
      validator: "v",
      message: "first; second",
      issues: [
        { path: ["a"], message: "first", code: "custom" },
        { path: ["b"], message: "second", code: "custom" },
      ],
      input: "x",
    });
    expect(mapZodError(err)?.message).toBe("first");
  });

  it("returns undefined for a ValidationError with no issues", () => {
    const err = new ValidationError({
      validator: "v",
      message: "no issues",
      issues: [],
      input: "x",
    });
    expect(mapZodError(err)).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// previewInput — sanitized, bounded diagnostics
// --------------------------------------------------------------------------

describe("previewInput", () => {
  it("returns short strings unchanged", () => {
    expect(previewInput("0x1234")).toBe("0x1234");
    expect(previewInput("")).toBe("");
  });

  it("truncates to INPUT_PREVIEW_MAX_LENGTH characters", () => {
    const long = "a".repeat(500);
    const preview = previewInput(long);
    expect(preview).toHaveLength(INPUT_PREVIEW_MAX_LENGTH);
    expect(preview).toBe(long.slice(0, INPUT_PREVIEW_MAX_LENGTH));
  });

  it("replaces control characters so a crafted input cannot forge a log line", () => {
    const forged = 'a\n[validation:error] {"validator":"spoofed"}';
    const preview = previewInput(forged);
    expect(preview).not.toContain("\n");
    expect(preview).not.toContain("\r");
    expect(previewInput("a\tb")).toBe("a b");
    expect(previewInput("a\u0000b")).toBe("a b");
    expect(previewInput("a\u007fb")).toBe("a b");
  });

  it("renders non-string values by type tag rather than by content", () => {
    // An object body must never have its contents echoed into the log stream.
    expect(previewInput({ password: "hunter2" })).toBe("[object Object]");
    expect(previewInput(12345)).toBe("12345");
    expect(previewInput(null)).toBe("null");
    expect(previewInput(undefined)).toBe("undefined");
    expect(previewInput(true)).toBe("true");
  });

  it("degrades to '[unserializable]' instead of throwing on a hostile value", () => {
    const nullProto = Object.create(null) as object;
    expect(() => previewInput(nullProto)).not.toThrow();
    expect(previewInput(nullProto)).toBe("[unserializable]");

    const throwing = {
      toString() {
        throw new Error("nope");
      },
    };
    expect(() => previewInput(throwing)).not.toThrow();
    expect(previewInput(throwing)).toBe("[unserializable]");

    expect(() => previewInput(Symbol("s"))).not.toThrow();
    expect(previewInput(Symbol("s"))).toBe("Symbol(s)");
  });
});

// --------------------------------------------------------------------------
// ValidationError — status is pinned to the client-error range
// --------------------------------------------------------------------------

describe("ValidationError status boundary", () => {
  const build = (status?: number) =>
    new ValidationError({
      validator: "statusTest",
      message: "fail",
      issues: [],
      input: "",
      status,
    });

  it("keeps an explicit 4xx status", () => {
    expect(build(400).status).toBe(400);
    expect(build(403).status).toBe(403);
    expect(build(422).status).toBe(422);
    expect(build(499).status).toBe(499);
  });

  it("never lets a validation failure be reported as a success", () => {
    // The global error handler replays err.status verbatim; a 2xx here would
    // turn a rejected request into a fail-open 200.
    expect(build(200).status).toBe(400);
    expect(build(204).status).toBe(400);
    expect(build(302).status).toBe(400);
    expect(build(399).status).toBe(400);
  });

  it("never lets a client error be reported as a server fault", () => {
    expect(build(500).status).toBe(400);
    expect(build(503).status).toBe(400);
  });

  it("collapses out-of-range, non-integer, and non-finite statuses to 400", () => {
    expect(build(0).status).toBe(400);
    expect(build(-1).status).toBe(400);
    expect(build(9999).status).toBe(400);
    expect(build(400.5).status).toBe(400);
    expect(build(Number.NaN).status).toBe(400);
    expect(build(Number.POSITIVE_INFINITY).status).toBe(400);
    // @ts-expect-error: intentionally invalid input type
    expect(build("422").status).toBe(400);
    expect(build(undefined).status).toBe(400);
  });

  it("sanitizes the input preview stored on the error", () => {
    const err = new ValidationError({
      validator: "sanitize",
      message: "fail",
      issues: [],
      input: `bad\ninput${"x".repeat(200)}`,
    });
    expect(err.input).not.toContain("\n");
    expect(err.input.length).toBeLessThanOrEqual(INPUT_PREVIEW_MAX_LENGTH);
    expect(err.metric.input).toBe(err.input);
    expect(err.toJSON().input).toBe(err.input);
  });

  it("coerces a non-array issues value to an empty array", () => {
    // @ts-expect-error: intentionally invalid input type
    const err = new ValidationError({ validator: "v", message: "m", issues: null, input: "" });
    expect(err.issues).toEqual([]);
  });

  it("defaults the legacy positional form to 400", () => {
    const err = new ValidationError("legacy message", "legacyValidator", "legacyInput");
    expect(err.status).toBe(400);
    expect(err.validator).toBe("legacyValidator");
    expect(err.input).toBe("legacyInput");
    expect(err.issues).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// isValidationError
// --------------------------------------------------------------------------

describe("isValidationError", () => {
  it("recognizes a ValidationError instance", () => {
    const err = new ValidationError({ validator: "v", message: "m", issues: [], input: "" });
    expect(isValidationError(err)).toBe(true);
  });

  it("recognizes a structurally equivalent error from another module instance", () => {
    // A duplicate copy of this module (bundling, pnpm hoisting) breaks
    // `instanceof` but not the contract, so the guard falls back to shape.
    const foreign = Object.assign(new Error("m"), { name: "ValidationError", issues: [] });
    expect(isValidationError(foreign)).toBe(true);
  });

  it("rejects a ZodError, a plain Error, and non-error values", () => {
    const parsed = z.string().safeParse(1);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(isValidationError(parsed.error)).toBe(false);
    expect(isValidationError(new Error("boom"))).toBe(false);
    expect(isValidationError(null)).toBe(false);
    expect(isValidationError(undefined)).toBe(false);
    expect(isValidationError("ValidationError")).toBe(false);
    expect(isValidationError({ name: "ValidationError", issues: [] })).toBe(false);
  });

  it("rejects an error named ValidationError without an issues array", () => {
    const impostor = Object.assign(new Error("m"), { name: "ValidationError" });
    expect(isValidationError(impostor)).toBe(false);
  });
});

// --------------------------------------------------------------------------
// formatValidationError — ValidationError support
// --------------------------------------------------------------------------

describe("formatValidationError — ValidationError", () => {
  it("maps a ValidationError to 'Validation failed' with its issues", () => {
    const err = new ValidationError({
      validator: "fmt",
      message: "bad thing",
      issues: [{ path: ["field"], message: "required", code: "custom" }],
      input: "raw",
    });
    const result = formatValidationError(err);
    expect(result.error).toBe("Validation failed");
    expect(result.details).toEqual([{ path: ["field"], message: "required", code: "custom" }]);
  });

  it("maps the ValidationError thrown by loggedParse without losing issues", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let caught: unknown;
    try {
      loggedParse(StarknetAddress, "not-an-address", "fmtRoundTrip");
    } catch (e) {
      caught = e;
    }
    const result = formatValidationError(caught);
    expect(result.error).toBe("Validation failed");
    expect(result.details?.length).toBeGreaterThanOrEqual(1);
    vi.restoreAllMocks();
  });

  it("never echoes the offending input or an internal message", () => {
    const err = new ValidationError({
      validator: "leak",
      message: "internal detail",
      issues: [],
      input: "super-secret-token",
    });
    const serialized = JSON.stringify(formatValidationError(err));
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("internal detail");
    expect(JSON.stringify(formatValidationError(new Error("db host db-1 refused")))).not.toContain(
      "db-1",
    );
  });
});

// --------------------------------------------------------------------------
// loggedParse — hostile input must not escalate a 400 into a 500
// --------------------------------------------------------------------------

describe("loggedParse — hostile input", () => {
  it("throws a ValidationError (not a TypeError) for a null-prototype object", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hostile = Object.create(null) as object;
    let caught: unknown;
    try {
      loggedParse(z.string(), hostile, "nullProto");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).status).toBe(400);
    expect((caught as ValidationError).input).toBe("[unserializable]");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("throws a ValidationError for a value whose toString throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hostile = {
      toString() {
        throw new Error("nope");
      },
    };
    expect(() => loggedParse(z.string(), hostile, "throwingToString")).toThrow(ValidationError);
    warn.mockRestore();
  });

  it("emits exactly one parseable log record for an input containing newlines", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      loggedParse(AgreementId, 'a\n[validation:error] {"validator":"spoofed"}', "logForge"),
    ).toThrow(ValidationError);
    expect(warn).toHaveBeenCalledTimes(1);
    const raw = warn.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw.replace("[validation:error] ", "")) as ValidationErrorMetric;
    expect(parsed.validator).toBe("logForge");
    expect(parsed.input).not.toContain("\n");
    warn.mockRestore();
  });

  it("does not echo an object payload's contents into the log", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => loggedParse(z.string(), { password: "hunter2" }, "objectBody")).toThrow(
      ValidationError,
    );
    const raw = warn.mock.calls[0][0] as string;
    expect(raw).not.toContain("hunter2");
    expect(raw).toContain("[object Object]");
    warn.mockRestore();
  });
});

// --------------------------------------------------------------------------
// Global error handler contract
// --------------------------------------------------------------------------

describe("global error handler contract", () => {
  // Mirrors the mapping in src/index.ts: a thrown error's `status` and
  // `issues` are replayed verbatim. These assertions pin the invariants that
  // handler depends on.
  const replay = (err: { status?: unknown; issues?: unknown }) => ({
    status: typeof err.status === "number" ? err.status : 500,
    details: err.issues ?? undefined,
  });

  it("replays a loggedParse failure as a 400 with a structured issue list", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let caught: unknown;
    try {
      loggedParse(AgreementId, "not-numeric", "handlerContract");
    } catch (e) {
      caught = e;
    }
    const replayed = replay(caught as ValidationError);
    expect(replayed.status).toBe(400);
    expect(Array.isArray(replayed.details)).toBe(true);
    expect((replayed.details as ValidationIssue[]).length).toBeGreaterThanOrEqual(1);
    vi.restoreAllMocks();
  });

  it("cannot be steered out of the 4xx range by the thrower", () => {
    for (const status of [200, 201, 302, 500, 503, -1, 0, 9999]) {
      const err = new ValidationError({
        validator: "steer",
        message: "m",
        issues: [],
        input: "",
        status,
      });
      const replayed = replay(err);
      expect(replayed.status).toBeGreaterThanOrEqual(400);
      expect(replayed.status).toBeLessThanOrEqual(499);
    }
  });
});

// --------------------------------------------------------------------------
// parsePagination — safe-integer boundary
// --------------------------------------------------------------------------

describe("parsePagination — safe-integer boundary", () => {
  it("falls back to defaults for magnitudes beyond Number.MAX_SAFE_INTEGER", () => {
    // These pass Zod's .int() (no fractional part) but cannot be represented
    // exactly, so clamping them would hand a lossy number to the query layer.
    expect(parsePagination({ limit: "1e20" }).limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(parsePagination({ limit: "1e308" }).limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(parsePagination({ offset: "1e20" }).offset).toBe(0);
    expect(parsePagination({ offset: "-1e20" }).offset).toBe(0);
    expect(parsePagination({ offset: Number.MAX_SAFE_INTEGER + 2 }).offset).toBe(0);
  });

  it("accepts the exact safe-integer boundary for offset", () => {
    expect(parsePagination({ offset: Number.MAX_SAFE_INTEGER }).offset).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("always returns safe integers", () => {
    const inputs: unknown[] = [
      { limit: "1e20", offset: "1e20" },
      { limit: "Infinity", offset: "-Infinity" },
      { limit: "NaN", offset: "NaN" },
      { limit: Number.MAX_VALUE, offset: Number.MAX_VALUE },
      { limit: -0, offset: -0 },
      "junk",
      null,
    ];
    for (const input of inputs) {
      const out = parsePagination(input);
      expect(Number.isSafeInteger(out.limit)).toBe(true);
      expect(Number.isSafeInteger(out.offset)).toBe(true);
      expect(out.limit).toBeGreaterThanOrEqual(1);
      expect(out.limit).toBeLessThanOrEqual(MAX_PAGE_LIMIT);
      expect(out.offset).toBeGreaterThanOrEqual(0);
    }
  });
});

// --------------------------------------------------------------------------
// isPlainObject
// --------------------------------------------------------------------------

describe("isPlainObject", () => {
  it("accepts plain and null-prototype objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it("rejects null, undefined, arrays, and primitives", () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject([1, 2])).toBe(false);
    expect(isPlainObject("str")).toBe(false);
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject(true)).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Billing Request Validation
// --------------------------------------------------------------------------

describe("Billing Request Validation", () => {
  describe("CurrencyCodeSchema", () => {
    it("accepts supported currency codes", () => {
      for (const currency of SUPPORTED_CURRENCIES) {
        expect(CurrencyCodeSchema.parse(currency)).toBe(currency);
      }
    });

    it("trims whitespace from valid currency code", () => {
      expect(CurrencyCodeSchema.parse("  USD  ")).toBe("USD");
    });

    it("rejects unknown currencies", () => {
      expect(() => CurrencyCodeSchema.parse("XYZ")).toThrow(z.ZodError);
      expect(() => CurrencyCodeSchema.parse("BTC")).toThrow(z.ZodError);
    });

    it("rejects invalid format (lowercase, length != 3, numbers)", () => {
      expect(() => CurrencyCodeSchema.parse("usd")).toThrow(z.ZodError);
      expect(() => CurrencyCodeSchema.parse("USDD")).toThrow(z.ZodError);
      expect(() => CurrencyCodeSchema.parse("US")).toThrow(z.ZodError);
      expect(() => CurrencyCodeSchema.parse("123")).toThrow(z.ZodError);
    });

    it("rejects empty / blank values", () => {
      expect(() => CurrencyCodeSchema.parse("")).toThrow(z.ZodError);
      expect(() => CurrencyCodeSchema.parse("   ")).toThrow(z.ZodError);
    });
  });

  describe("BillingAmountSchema", () => {
    it("accepts valid positive numbers and numeric strings", () => {
      expect(BillingAmountSchema.parse(100)).toBe(100);
      expect(BillingAmountSchema.parse("100")).toBe(100);
      expect(BillingAmountSchema.parse(50.5)).toBe(50.5);
      expect(BillingAmountSchema.parse("50.5")).toBe(50.5);
      expect(BillingAmountSchema.parse(1_000_000)).toBe(1_000_000);
    });

    it("rejects zero amount", () => {
      expect(() => BillingAmountSchema.parse(0)).toThrow();
      expect(() => BillingAmountSchema.parse("0")).toThrow();
    });

    it("rejects negative amounts", () => {
      expect(() => BillingAmountSchema.parse(-10)).toThrow();
      expect(() => BillingAmountSchema.parse("-50.5")).toThrow();
    });

    it("rejects amounts exceeding maximum allowed limit", () => {
      expect(() => BillingAmountSchema.parse(1_000_001)).toThrow();
      expect(() => BillingAmountSchema.parse("2000000")).toThrow();
    });

    it("supports custom maxAmount limit via createBillingAmountSchema", () => {
      const customSchema = createBillingAmountSchema(500);
      expect(customSchema.parse(500)).toBe(500);
      expect(() => customSchema.parse(501)).toThrow();
    });

    it("rejects non-finite values and invalid string inputs", () => {
      expect(() => BillingAmountSchema.parse(Infinity)).toThrow();
      expect(() => BillingAmountSchema.parse(NaN)).toThrow();
      expect(() => BillingAmountSchema.parse("abc")).toThrow();
      expect(() => BillingAmountSchema.parse("")).toThrow();
    });
  });

  describe("validateBillingInput & validateBillingRequest", () => {
    it("validates valid input object successfully", () => {
      const result = validateBillingInput({ currency: "USD", amount: 250 });
      expect(result).toEqual({ currency: "USD", amount: 250 });
    });

    it("allows omitting optional fields when not required", () => {
      const result = validateBillingInput({});
      expect(result).toEqual({});
    });

    it("throws ValidationError for invalid currency code", () => {
      expect(() => validateBillingInput({ currency: "BAD" })).toThrow(ValidationError);
      try {
        validateBillingInput({ currency: "BAD" });
      } catch (err: any) {
        expect(err.status).toBe(400);
        expect(err.message).toContain("Unsupported currency code 'BAD'");
      }
    });

    it("throws ValidationError for invalid billing amount", () => {
      expect(() => validateBillingInput({ amount: -100 })).toThrow(ValidationError);
      try {
        validateBillingInput({ amount: -100 });
      } catch (err: any) {
        expect(err.status).toBe(400);
        expect(err.message).toContain("greater than zero");
      }
    });

    it("extracts and validates from Express Request object", () => {
      const req = { query: { currency: "EUR", amount: "500" } };
      const result = validateBillingRequest(req);
      expect(result).toEqual({ currency: "EUR", amount: 500 });
    });
  });
});
