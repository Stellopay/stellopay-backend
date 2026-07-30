# Runbook: Session Store

**Owner:** Backend / Auth  
**Severity when triggered:** High (users cannot authenticate)

---

## Overview

Sessions are persisted in PostgreSQL (`sessions` table) with SHA-256-hashed
tokens, sliding expiry, hard absolute TTL caps, and per-family rotation.
`src/auth/session.ts` owns the full lifecycle: creation, validation,
rotation, revocation, and background sweeping of expired rows.

Failures typically manifest as login failures, unexpected logouts, or
`session.rejected` spikes.

---

## Symptoms

| Symptom                                                                | Likely Cause                                   |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| `session.rejected` with `reason: "db_error"` in logs                  | PostgreSQL connectivity issue                  |
| `session.rejected` with `reason: "expired_sliding"` / `"expired_absolute"` | Session TTLs too short or clock skew       |
| `session.rejected` with `reason: "unknown_token"`                     | Token not in DB (swept, revoked, or never created) |
| `session_rejected_total` spike                                        | Mass session invalidation or DB issue          |
| `session.reuse_detected` + `session.family_revoked`                   | Possible token theft — stale token replayed    |
| `session.sweep_failed` / `session.sweeper_crashed`                    | Sweeper encountering DB errors                 |
| `session_revoke_failed_total` incrementing                            | Revocation writes failing (single/family/all)  |
| Users reporting unexpected logouts                                     | Token rotation, sweep, or TTL issue            |

---

## Relevant Environment Variables

| Variable              | Default           | Description                                     |
| --------------------- | ----------------- | ----------------------------------------------- |
| `SESSION_TTL_MS`      | `86400000`        | Sliding expiry for a session token (24 hours)   |
| `SESSION_MAX_TTL_MS`  | `604800000`       | Absolute max lifetime of a token family (7 days) |
| `POSTGRES_CONNECTION_STRING` | *(required)* | Primary database (sessions table)              |

Internal constants (not env-configurable):

| Constant                        | Value     | Purpose                                |
| ------------------------------- | --------- | -------------------------------------- |
| `SESSION_UPDATE_THRESHOLD_MS`   | `60000`   | Min interval between DB writes for sliding expiry |
| `SESSION_SWEEP_INTERVAL_MS`     | `600000`  | Background sweeper cadence (10 min)    |
| `SESSION_SWEEP_BATCH_SIZE`      | `500`     | Rows per sweep DELETE batch            |
| `SESSION_REVOKE_BATCH_SIZE`     | `100`     | Rows per bulk-revoke UPDATE batch      |

---

## Diagnostics Endpoints to Check First

### 1. Session metrics snapshot

Session metrics are process-local counters and gauges exposed via
`getSessionMetricsSnapshot()`.  Check the diagnostics endpoint (or a debug
route if one exists) for:

| Counter / Gauge                          | What to look for                          |
| ---------------------------------------- | ----------------------------------------- |
| `session_rejected_total`                 | Spike → investigate `reason` breakdown    |
| `session_rejected_unknown_token_total`   | High → tokens being swept or lost         |
| `session_rejected_expired_total`         | High → TTLs too short or clock sync issue |
| `session_reuse_detected_total`           | Non-zero → possible token compromise      |
| `session_sweep_deleted_total`            | Very high → normal churn or config issue  |
| `session_sweeper_errors_total`           | Non-zero → DB connectivity problems       |
| `session_revoke_failed_total`            | Non-zero → DB write failures              |
| `session_sweeper_last_deleted_count`     | Gauge — check sweep batch sizes           |
| `session_sweeper_last_run_at_ms`         | Gauge — verify sweeper is running         |

### 2. `GET /api/v1/system/ready`

Check `database` status — if `"unreachable"`, sessions cannot be created,
validated, or swept.

---

## Step-by-Step Response

### 1. Session creation failures

Users cannot log in.  Check:

```bash
# Verify DB connectivity
psql "$POSTGRES_CONNECTION_STRING" -c "SELECT 1;"
```

If the database is reachable but session creation fails:

1. Check that the `sessions` table exists and has no schema drift:
   ```sql
   SELECT count(*) FROM sessions;
   ```
2. Check for disk space, connection pool exhaustion, or long-running
   transactions blocking writes.

### 2. Mass session invalidation (users logged out)

1. Check for `session.family_revoked` log events — these indicate token
   reuse detection triggering family-wide revocation.
2. Check for `session.all_revoked` — this indicates an explicit "sign out
   everywhere" or admin lockdown action.
3. Verify server clock is synced (NTP).  Clock skew between the app server
   and the database can cause premature expiry.
4. High `session_sweep_deleted_total` counts indicate normal expiration
   churn, not a logout bug — the sweeper only removes sessions that are
   *already* expired or revoked.

### 3. Token reuse detection (security incident)

`session.reuse_detected` fires when a token that was already rotated or
revoked is presented for rotation.  This is a potential compromise signal.

1. Identify the affected `family_id` from the log line.
2. The entire family is already revoked by the detection path — no further
   action is needed to invalidate those tokens.
3. Notify the affected user to re-authenticate.
4. If reuse detections are frequent and widespread, investigate whether
   client code is double-submitting tokens or whether tokens are being
   intercepted.

### 4. Sweeper failures

1. Check `session_sweeper_errors_total` — if non-zero, check the
   `session.sweep_failed` log for the specific DB error.
2. Common causes: connection pool exhaustion, statement timeout, or disk
   full.
3. The sweeper is self-healing — it will retry on the next 10-minute tick.
   No immediate restart is needed unless errors persist across multiple
   cycles.

### 5. Revocation failures

1. Check `session_revoke_failed_total`.  Each increment corresponds to a
   `session.revoke_failed` error log with `kind` (`single` / `family` /
   `all`) and `phase` (`select` / `update`).
2. The retry policy is 3 attempts with 50ms backoff.  If all 3 attempts
   fail, the error propagates to the route handler (returning 5xx).
3. Confirm that the database is not under excessive load and that WAL
   replication is not falling behind.

---

## Emergency Tuning

| Problem                                 | Quick Tweak                                |
| --------------------------------------- | ------------------------------------------ |
| Sessions expiring too fast              | Increase `SESSION_TTL_MS`                  |
| DB writes too frequent from sliding     | `SESSION_UPDATE_THRESHOLD_MS` is already 60s; reduce further if needed (code change) |
| Sweep too aggressive                    | Increase `SESSION_SWEEP_INTERVAL_MS` (code change) |
| Revocation timeouts                     | Increase `SESSION_REVOKE_BATCH_SIZE` to reduce round-trips (trade-off: lock duration) |

---

## Metrics Reference

See `docs/auth/session.md` for the complete observability contract
including all counter names, log event shapes, and the bounded `reason`
enum for `session.rejected`.
