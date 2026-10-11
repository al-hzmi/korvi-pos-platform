# Gate 5 — Full-Shift Offline Proof Contract

This proof exercises the supported Korvi cashier offline semantics with a time-compressed representative workload. It deliberately does **not** claim an 8–12 hour wall-clock device run.

The automated evidence must use the dedicated `/cashier` product surface and must prove all of the following on one exact source SHA:

- a representative backlog larger than one bounded synchronization batch;
- catalogue, active sale draft and ordered transaction queue persistence;
- stable UUIDv7 operation identities and capture ordering;
- process restart while WAN is unavailable without queue attempts or data loss;
- reconnect with bounded server replay and server-side idempotency;
- process termination after partial synchronization, followed by same-profile recovery;
- every accepted operation represented exactly once in authoritative sales/invoice/inventory effects;
- zero missing operations, zero duplicate financial effects and zero duplicate stock effects;
- explicit retained rejection/needs-review behavior if a definitive server conflict occurs;
- PostgreSQL 17 migration/drift evidence under a restricted `NOSUPERUSER` / `NOBYPASSRLS` application role.

Browser evidence here validates the offline engine and recovery semantics. It does not replace Gate 11 installed Windows/Android evidence.
