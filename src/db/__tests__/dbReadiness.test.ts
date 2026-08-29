// src/db/__tests__/dbReadiness.test.ts
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import { waitForDbReadiness } from '../../db/index.js';
import { env } from '../../config.js';

beforeEach(() => {
  // Use small retry config for fast tests
  env.DB_CONNECTION_RETRY_MAX_ATTEMPTS = 3;
  env.DB_CONNECTION_RETRY_BASE_DELAY_MS = 10;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('waitForDbReadiness', () => {
  let querySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    querySpy = vi.spyOn(Pool.prototype, 'query');
  });

  afterEach(() => {
    querySpy.mockRestore();
    vi.useRealTimers();
  });

  it('resolves when DB becomes healthy before max attempts', async () => {
    querySpy
      .mockRejectedValueOnce(new Error('db unavailable'))
      .mockRejectedValueOnce(new Error('db unavailable'))
      .mockResolvedValueOnce({
        rows: [{ '?column?': 1 }],
        command: 'SELECT',
        rowCount: 1,
      } as never);
    const promise = waitForDbReadiness();
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();
    expect(querySpy).toHaveBeenCalledTimes(3);
  });

  it('rejects after exhausting all attempts', async () => {
    querySpy.mockRejectedValue(new Error('db unavailable'));
    const promise = waitForDbReadiness();
    // Attach the rejection handler before running the fake timers so the
    // rejection is handled synchronously and cannot surface as an unhandled
    // rejection while `runAllTimersAsync` processes the retry delay timers.
    const rejection = expect(promise).rejects.toThrowError(/Unable to connect to database/);
    await vi.runAllTimersAsync();
    await rejection;
    expect(querySpy).toHaveBeenCalledTimes(env.DB_CONNECTION_RETRY_MAX_ATTEMPTS);
  });
});
