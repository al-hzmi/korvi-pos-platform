#!/usr/bin/env bash
#
# Mechanical scan for the invariants in CLAUDE.md that a type system cannot
# express. Runs as part of `npm run verify`.
#
# Every check names the rule it protects. A finding is a build failure, not a
# warning: a warning nobody acts on is a rule nobody follows.

set -uo pipefail

FAILED=0
SRC_GLOBS=(packages apps)

report() {
  printf '\033[1;31m[x] %s\033[0m\n' "$1" >&2
  FAILED=1
}

scan() {
  local description="$1" pattern="$2" include="$3" path_filter="${4:-}" path_exclude="${5:-}"
  local hits
  hits="$(grep -rEn --include="$include" \
            --exclude-dir=node_modules --exclude-dir=dist \
            --exclude-dir=.next --exclude-dir=generated --exclude-dir=coverage \
            "$pattern" "${SRC_GLOBS[@]}" 2>/dev/null || true)"

  if [ -n "$path_filter" ] && [ -n "$hits" ]; then
    hits="$(printf '%s\n' "$hits" | grep -E "$path_filter" || true)"
  fi

  if [ -n "$path_exclude" ] && [ -n "$hits" ]; then
    hits="$(printf '%s\n' "$hits" | grep -Ev "$path_exclude" || true)"
  fi

  if [ -n "$hits" ]; then
    report "$description"
    printf '%s\n' "$hits" | sed 's/^/      /' >&2
  fi
}

echo "Scanning invariants..."

# --- TypeScript escape hatches -------------------------------------------
scan "'any' type used (CLAUDE.md: TypeScript)" \
     '(: *any\b|<any>|as +any\b|Array<any>)' '*.ts'
scan "'any' type used in TSX (CLAUDE.md: TypeScript)" \
     '(: *any\b|as +any\b)' '*.tsx'
scan "@ts-ignore used — use @ts-expect-error with a justification" \
     '@ts-ignore' '*.ts'

# --- Money (ADR-0002) -----------------------------------------------------
scan "parseFloat near money — use moneyFromMajorString (ADR-0002)" \
     '\bparseFloat\s*\(' '*.ts' '^packages/domain/'
scan "Math rounding on an amount — use mulDivRound (ADR-0002)" \
     '\bMath\.(round|floor|ceil)\s*\(' '*.ts' '^packages/domain/src/(money|tax|tender)/'
scan "float literal in the financial core (ADR-0002)" \
     '=\s*[0-9]+\.[0-9]+\s*;' '*.ts' '^packages/domain/src/(money|tax|tender)/'

# --- Domain purity (ADR-0001) --------------------------------------------
scan "React imported into the domain (ADR-0001)" \
     "from +'react" '*.ts' '^packages/domain/'
scan "Prisma imported into the domain (ADR-0001)" \
     "from +'@?prisma" '*.ts' '^packages/domain/'
scan "Fastify imported into the domain (ADR-0001)" \
     "from +'fastify" '*.ts' '^packages/domain/'
scan "Node filesystem imported into the domain (ADR-0001)" \
     "from +'node:(fs|path)" '*.ts' '^packages/domain/'

# --- Design system (ADR-0006) --------------------------------------------
# theme-color.ts is the single sanctioned exception: <meta name="theme-color">
# is read by the browser chrome, which cannot resolve a CSS variable. Keeping
# the exception to one named file is what stops it spreading.
scan "colour literal in a component — use a token (KORVI-DESIGN-SYSTEM.md §1.1)" \
     '(#[0-9a-fA-F]{3,8}\b|rgba?\()' '*.tsx'
scan "colour literal outside theme-color.ts — use a token (§1.1)" \
     '(#[0-9a-fA-F]{3,8}\b)' '*.ts' '^packages/ui/src/' 'theme-color\.ts'
scan "physical direction utility — use logical properties (§6)" \
     '\b(ml|mr|pl|pr)-[0-9a-z]' '*.tsx'
scan "physical inset utility — use start-/end- (§6)" \
     '\b(left|right)-[0-9]' '*.tsx'
scan "text-left/text-right — use text-start/text-end (§6)" \
     '\btext-(left|right)\b' '*.tsx'

# --- Printing (ADR-0008) --------------------------------------------------
scan "raw TextEncoder in printing — go through encodeTextFor (ADR-0008)" \
     'new TextEncoder\(\)' '*.ts' '^packages/printing/src/(escpos|receipt)'

# --- Tenancy (ADR-0004) ---------------------------------------------------
scan "session-wide SET for tenant context — must be SET LOCAL (ADR-0004)" \
     'executeRaw.*[^_]SET +app\.tenant_id' '*.ts'

# --- Secrets --------------------------------------------------------------
scan "possible committed credential" \
     '(postgres(ql)?://[^"'"'"' ]*:[^"'"'"' @]+@|BEGIN [A-Z ]*PRIVATE KEY|sk_live_|AKIA[0-9A-Z]{16})' \
     '*.ts'

if [ "$FAILED" -eq 0 ]; then
  printf '\033[1;32m[ok]\033[0m invariants clean\n'
else
  printf '\033[1;31m[x]\033[0m invariant scan failed\n' >&2
fi

exit "$FAILED"
