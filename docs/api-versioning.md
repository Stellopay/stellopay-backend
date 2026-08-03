# API Versioning

## Version Signal

Every response under `/api/v1` carries an `API-Version: 1` header so that
clients can detect the active API version without parsing the URL path.

The version constant is defined in `src/index.ts` as `API_VERSION` and is
applied globally via Express middleware on the `/api/v1` mount point.

## Deprecation Policy

When a new major API version is introduced:

1. **Announcement** - The new version path (e.g. `/api/v2`) is announced via
   the project README and a `Sunset` header on `/api/v1` responses at least
   **6 months** before the v1 shutdown date.

2. **Coexistence** - `/api/v1` and `/api/v2` run side-by-side for the full
   deprecation window.

3. **Sunset header** - During the deprecation window every `/api/v1` response
   carries a `Sunset` HTTP header with the shutdown date in ISO 8601 format
   (e.g. `Sunset: Sat, 01 Jan 2028 00:00:00 GMT`) and a `Deprecation` header
   set to `true`.

4. **Minimum support window** - The current `/api/v1` is guaranteed to remain
   available for at least **6 months** after `/api/v2` reaches general
   availability.

5. **Breaking changes** - No breaking changes are ever made to a published
   API version. Any change that would alter request/response contracts,
   remove fields, or change status-code semantics requires a new major
   version.
