export type LockoutRecord = {
  failures: number;
  lockedUntil: number;
};

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * In-memory map of failed attempts and lockout states per wallet address.
 */
export const lockouts = new Map<string, LockoutRecord>();

/**
 * Records a failed login attempt for the given address.
 * If failures reach MAX_FAILURES, locks the account for LOCKOUT_MS.
 */
export function recordFailure(address: string) {
  const key = address.toLowerCase();
  let rec = lockouts.get(key);

  if (!rec || rec.lockedUntil < Date.now()) {
    // Start fresh if no record or previous lock expired
    rec = { failures: 0, lockedUntil: 0 };
  }

  rec.failures++;
  
  if (rec.failures >= MAX_FAILURES) {
    rec.lockedUntil = Date.now() + LOCKOUT_MS;
    
    // Log lockout event
    console.warn(JSON.stringify({
      metric: "account_lockout",
      address: key,
      locked_for_ms: LOCKOUT_MS,
      timestamp: new Date().toISOString()
    }));
  }

  lockouts.set(key, rec);
}

/**
 * Checks if the given address is currently locked out.
 */
export function isLockedOut(address: string): boolean {
  const key = address.toLowerCase();
  const rec = lockouts.get(key);
  
  if (!rec) return false;
  
  return rec.lockedUntil > Date.now();
}

/**
 * Clears failures and lockout state for the given address upon successful login.
 */
export function clearFailures(address: string) {
  lockouts.delete(address.toLowerCase());
}
