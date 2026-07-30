# Circuit-breaker metrics

The Starknet client exposes two process-local metrics for each RPC endpoint:

- `starknet_circuit_breaker_state`, a gauge where `0=CLOSED`, `1=OPEN`, and
  `2=HALF_OPEN`.
- `starknet_circuit_breaker_transitions_total`, a counter labeled with the
  endpoint and transition name, such as `CLOSED_to_OPEN`.

Alert when an endpoint remains `OPEN` (state `1`) for longer than the normal
RPC recovery window, or when `CLOSED_to_OPEN` transitions repeat rapidly. A
useful starting threshold is state `1` for more than five minutes, adjusted
for the configured circuit-breaker cooldown and the number of healthy fallback
endpoints.
