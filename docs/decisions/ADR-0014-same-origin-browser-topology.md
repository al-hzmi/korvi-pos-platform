# ADR-0014 — The browser talks to its own origin

Status: accepted
Date: 2026-08-14
Extends ADR-0012 (authentication), ADR-0013 (the checkout transaction).

## Context

Strike 2B put the session in an HttpOnly, SameSite=Lax, `__Host-` cookie and
made every state-changing request prove its `Origin` against an exact-match
list. That design only works if the browser and the API share an origin. The
obvious alternative — the browser calling `https://api.korvi.sa` directly from
`https://pos.korvi.sa` — breaks three of its four guarantees at once:
`__Host-` cannot be used across hosts, SameSite=Lax stops sending the cookie on
the requests that matter, and CORS has to be opened wide enough to let
credentials through.

## Decision

The browser calls `/v1/*` on the origin it was served from. Next rewrites that
path to Fastify.

```
browser ──/v1/sales──▶ Next (same origin) ──▶ Fastify
```

Consequences that follow from it rather than from any extra work:

- **No CORS anywhere.** Nothing crosses an origin, so there is no preflight to
  answer and no allow-list to widen. A wildcard would be impossible to reach
  even by accident.
- **The cookie stays first-party** on the host the cashier typed, which is what
  `__Host-` requires and what SameSite=Lax assumes.
- **The Origin header stays the browser's own.** Fastify's check in
  `apps/api/src/auth/origin.ts` is unchanged and still exact-match; the value it
  compares is the real origin, not something a proxy synthesised.
  `X-Forwarded-*` remains ignored, as it was.
- **No token exists in JavaScript.** There is nothing to attach to a request,
  nothing to put in `localStorage`, and nothing for a script on the page to
  read.

Next carries bytes. It does not authenticate, authorise, validate, price or
decide anything, and it must not start: every rule in Strikes 2B and 3A-1 lives
in Fastify, and a second implementation in a Node process nobody audits is how
those rules quietly diverge.

## Configuration

`KORVI_API_ORIGIN` names the upstream. It is read once, at build time, by
`resolveApiOrigin` (`apps/pos-web/src/lib/api-origin.ts`), which accepts a bare
`http`/`https` origin and nothing else — a value carrying a path, a query or
credentials stops the build rather than silently rewriting every API call
somewhere unintended.

Unset, it falls back to `http://127.0.0.1:3001`. Loopback is the deliberate
choice: a deployment that forgot to configure it fails to connect, which is
immediately visible, instead of reaching a host nobody chose.

The API's own `APP_ORIGINS` must list the public origin of this app — the one
the browser shows — and nothing else. In production Fastify refuses to boot
without it.

## Consequences

- One origin to serve, one certificate, one cookie domain.
- The API may be closed to the public internet entirely, reachable only from
  the web tier.
- A rewrite destination is baked into the build, so changing the upstream is a
  rebuild. That is the price of not resolving it per request, and it is the
  right side of the trade for a value that must never be attacker-influenced.
- The browser has no offline story and does not pretend to. A dropped
  connection surfaces as an ambiguous checkout the cashier may safely retry
  under the same operation id (ADR-0013), not as a queued sale.
