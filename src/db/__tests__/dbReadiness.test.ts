// src/db/__tests__/dbReadiness.test.ts
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { waitForDbReadiness } from '../../db/index.js';
import * as dbModule from '../../db/index.js';
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
  it('resolves when DB becomes healthy before max attempts', async () => {
    vi.useFakeTimers();
    const mockHealth = vi.spyOn(dbModule, 'checkDbHealth');
    mockHealth
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const promise = waitForDbReadiness();
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();
    expect(mockHealth).toHaveBeenCalledTimes(3);
  });

  it('rejects after exhausting all attempts', async () => {
    vi.useFakeTimers();
    const mockHealth = vi.spyOn(dbModule, 'checkDbHealth').mockResolvedValue(false);
    const promise = waitForDbReadiness();
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrowError(/Unable to connect to database/);
    expect(mockHealth).toHaveBeenCalledTimes(env.DB_CONNECTION_RETRY_MAX_ATTEMPTS);
  });
});
