#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
case "${1:-}" in
  api) ;;
  web)
    # Next bakes the rewrite into its build. Missing configuration must not
    # silently produce a cloud app that forwards to its own loopback.
    node --input-type=module -e '
      const value = process.env.KORVI_API_ORIGIN;
      let url;
      try { url = new URL(value ?? ""); } catch { process.exit(1); }
      if (url.protocol !== "https:" || url.origin !== value) process.exit(1);
    '
    ;;
  *) echo 'Usage: bash scripts/deploy/build.sh api|web' >&2; exit 1 ;;
esac

npm ci --include=dev --registry=https://registry.npmjs.org
# Generate reads the schema only; the web build never receives database secrets.
DATABASE_URL='postgresql://localhost/korvi_generate_only' npm run db:generate
npm run build -w @korvi/domain
npm run build -w @korvi/database
if [ "$1" = api ]; then
  npm run build -w @korvi/api
else
  npm run build -w @korvi/printing
  npm run build -w @korvi/ui
  npm run build -w @korvi/pos-web
fi
