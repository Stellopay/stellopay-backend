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
  type ValidationErrorResponse,
} from "./validation";
import type { ValidationErrorMetric } from "./validation";

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
    // Boundary: well-formed but with surrounding whitespace — must NOT throw.
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
    // 10,000 chars — well beyond the 64-char felt width. Must not hang or throw unexpectedly.
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
    // `0X` is uppercase `X` which is not a hex digit, so the whole token
    // fails the regex.
    expect(() => StarknetAddress.parse("0X")).toThrow();
  });

  it("rejects unicode that looks like hex digits", () => {
    // Fullwidth digits, Arabic-Indic digits, Devanagari digit — none are [0-9a-fA-F].
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
    // Boundary: well-formed but whitespace-wrapped — must NOT throw.
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
    // Boundary: literal null query — must hit the nullish-coalescing branch
    // and return the same defaults as `undefined`.
    expect(parsePagination(null)).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
  });

  it("uses defaults when limit/offset are explicit null or empty strings", () => {
    // Security boundary: previously these silently fell through Zod's
    // `coerce.number` → `Number(null) === 0` / `Number("") === 0` → `int()`
    // passes → clamps to 1, returning a single page. That was an
    // inconsistent fail-open. Now they fall back to the safe default.
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
    // 1e20 is finite and integer-shaped, but exceeds MAX_SAFE_INTEGER
    // (~9.0e15), so Zod's `.int()` check rejects it; `.catch()` returns DEFAULT.
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
    // Boundary: number that's already > MAX — should be clamped.
    expect(parsePagination({ limit: 1000 }).limit).toBe(MAX_PAGE_LIMIT);
    // Boundary: numeric zero — must clamp to 1, NOT to default.
    expect(parsePagination({ limit: 0 }).limit).toBe(1);
  });

  it("floors a negative offset to 0 and passes valid values through", () => {
    expect(parsePagination({ offset: "-3" }).offset).toBe(0);
    expect(parsePagination({ limit: "10", offset: "20" })).toEqual({
      limit: 10,
      offset: 20,
    });
    // Boundary: numeric (non-string) offset.
    expect(parsePagination({ offset: -1 }).offset).toBe(0);
  });

  it("falls back to defaults for non-numeric values", () => {
    expect(parsePagination({ limit: "abc", offset: "xyz" })).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
  });

  it("falls back to defaults for non-integer (true float) numeric strings", () => {
    // Float strings: Zod's .int() check uses Number.isInteger so 1.5 fails.
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
    // JS Number() resolves "1e2" → 100, "1.5e2" → 150, "0x10" → 16 — all
    // finite integers within safe-integer range, so .int() passes and the
    // values are clamped (or used as-is).
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
    // offset has no upper clamp — large offsets are allowed and just skip
    // many rows. Must not throw.
    const huge = String(Number.MAX_SAFE_INTEGER);
    expect(parsePagination({ offset: huge }).offset).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("does not throw on array, object, or boolean query values", () => {
    // Express can deliver arrays for repeated query keys. The function
    // MUST never throw — these just fall through to clamped values.
    expect(() => parsePagination({ limit: ["10"], offset: ["5"] })).not.toThrow();
    // Single-element arrays coerce to numbers via Number([x]).
    expect(parsePagination({ limit: ["10"], offset: ["5"] })).toEqual({
      limit: 10,
      offset: 5,
    });
    // Multi-element arrays coerce to NaN → fallback to DEFAULT.
    expect(parsePagination({ limit: ["10", "20"], offset: ["5", "6"] })).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
    expect(() => parsePagination({ limit: {}, offset: {} })).not.toThrow();
    expect(() => parsePagination({ limit: true, offset: false })).not.toThrow();
  });

  it("never throws regardless of input shape", () => {
    // The function must return a clamped object for any input — there's no
    // legitimate scenario where it should reject the request entirely; the
    // goal is graceful degradation. Each call must return finite numbers
    // within the documented bounds.
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
      () => parsePagination({ limit: "  10  " }), // whitespace string coerces to 10
      () => parsePagination({ limit: "Infinity" }),
      () => parsePagination({ limit: "NaN" }),
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
    // Boundary: well-formed-but-edge, whitespace-wrapped numeric.
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

  it("logs and throws on validation failure", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = z.string().min(1);
    expect(() => loggedParse(schema, "", "testSchema")).toThrow();
    expect(warn).toHaveBeenCalledOnce();
    const call = warn.mock.calls[0][0] as string;
    expect(call).toContain("[validation:error]");
    expect(call).toContain("testSchema");
    warn.mockRestore();
  });

  it("includes a truncated input preview in the log payload (max 40 chars)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Schema must actually REJECT the 200-char input for loggedParse to log
    // and throw. z.string().min(1) accepts any non-empty string, so we add
    // an explicit upper bound to force a failure.
    const schema = z.string().min(1).max(50);
    const long = "a".repeat(200);
    expect(() => loggedParse(schema, long, "longerSchema")).toThrow();
    const call = warn.mock.calls[0][0] as string;
    // The truncated 40-char substring is present in the log payload.
    const truncated = long.slice(0, 40);
    expect(call).toContain(truncated);
    // The full 200-char input must NOT appear — proves truncation worked.
    expect(call).not.toContain(long);
    warn.mockRestore();
  });

  it("stringifies non-string input via String() before logging", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 12345 is a number. z.string().min(1) rejects any non-string, so the
    // failure path runs through loggedParse's `String(value)` branch.
    expect(() => loggedParse(z.string().min(1), 12345, "numInput")).toThrow();
    const call = warn.mock.calls[0][0] as string;
    expect(call).toContain("numInput");
    // String(12345) === "12345" — confirm the non-string → string path.
    expect(call).toContain("12345");
    warn.mockRestore();
  });

  it("emits a JSON-formatted log with validator / input / error / timestamp", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = z.string().min(1);
    expect(() => loggedParse(schema, "", "abc")).toThrow();
    const raw = warn.mock.calls[0][0] as string;
    const json = raw.replace("[validation:error] ", "");
    const parsed: unknown = JSON.parse(json);
    expect(parsed).toMatchObject({
      validator: "abc",
      input: "",
      error: expect.any(String),
      timestamp: expect.any(String),
    });
    // Timestamp must be ISO 8601 — parseable as a Date and within reason.
    const ts = (parsed as { timestamp: string }).timestamp;
    expect(Number.isNaN(Date.parse(ts))).toBe(false);
    expect(Math.abs(Date.now() - Date.parse(ts))).toBeLessThan(60_000);
    warn.mockRestore();
  });

  it("joins multiple issue messages with '; '", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Schema must be valid (min <= max) — zod pre-compiles a regex that
    // throws SyntaxError if the bounds are inverted.
    // .min(5).email() with input "ab" produces 2 issues: "Too small" AND "Invalid email".
    const schema = z.string().min(5).email();
    expect(() => loggedParse(schema, "ab", "joined")).toThrow();
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
