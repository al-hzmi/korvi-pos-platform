# Third-Party License Technical Inventory

Source release: `61dbb34dea08809756fd767b907b0e852b7e5978`

Status: **TECHNICAL LOCKFILE INVENTORY — NOT A LEGAL OPINION**

This inventory is derived from the exact `package-lock.json` embedded in the buyer-evaluable source SHA. It records license metadata present in the npm lockfile. It does not replace legal review of license texts, distribution obligations, transitive native components, Rust/Tauri dependencies, provider terms or commercial use conditions.

## npm lockfile summary

External/local package entries under `node_modules`: **532**

License metadata counts:

| License metadata | Count |
|---|---:|
| MIT | 374 |
| Apache-2.0 | 53 |
| ISC | 33 |
| Apache-2.0 OR MIT | 13 |
| MPL-2.0 | 12 |
| BSD-3-Clause | 10 |
| LGPL-3.0-or-later | 10 |
| BSD-2-Clause | 7 |
| Apache-2.0 AND LGPL-3.0-or-later | 3 |
| Unlicense | 2 |
| Apache-2.0 AND LGPL-3.0-or-later AND MIT | 1 |
| MIT and ISC | 1 |
| CC-BY-4.0 | 1 |
| EPL-2.0 | 1 |
| BlueOak-1.0.0 | 1 |
| 0BSD | 1 |
| UNKNOWN | 9 |

The nine `UNKNOWN` entries are the local first-party Korvi workspace packages (`@korvi/*`) rather than unidentified third-party npm packages.

## Packages requiring explicit diligence attention

The following lockfile entries carry license metadata that deserves explicit transaction review rather than being silently grouped with MIT/Apache/BSD packages.

### LGPL-related native/image packages

- `@img/sharp-libvips-darwin-arm64@1.3.3` — LGPL-3.0-or-later
- `@img/sharp-libvips-darwin-x64@1.3.3` — LGPL-3.0-or-later
- `@img/sharp-libvips-linux-arm@1.3.3` — LGPL-3.0-or-later
- `@img/sharp-libvips-linux-arm64@1.3.3` — LGPL-3.0-or-later
- `@img/sharp-libvips-linux-ppc64@1.3.3` — LGPL-3.0-or-later
- `@img/sharp-libvips-linux-riscv64@1.3.3` — LGPL-3.0-or-later
- `@img/sharp-libvips-linux-s390x@1.3.3` — LGPL-3.0-or-later
- `@img/sharp-libvips-linux-x64@1.3.3` — LGPL-3.0-or-later
- `@img/sharp-libvips-linuxmusl-arm64@1.3.3` — LGPL-3.0-or-later
- `@img/sharp-libvips-linuxmusl-x64@1.3.3` — LGPL-3.0-or-later
- `@img/sharp-win32-arm64@0.35.4` — Apache-2.0 AND LGPL-3.0-or-later
- `@img/sharp-win32-ia32@0.35.4` — Apache-2.0 AND LGPL-3.0-or-later
- `@img/sharp-win32-x64@0.35.4` — Apache-2.0 AND LGPL-3.0-or-later
- `@img/sharp-wasm32@0.35.4` — Apache-2.0 AND LGPL-3.0-or-later AND MIT

### MPL-2.0

`lightningcss@1.33.0` and its platform packages carry MPL-2.0 metadata.

### EPL-2.0

- `elkjs@0.11.1`

### CC-BY-4.0

- `caniuse-lite@1.0.30001810`

## Transaction checklist

Before legal close:

- export complete third-party notices/license texts from the exact final release;
- determine which dependencies are shipped/distributed versus build-time/server-only;
- separately review native binaries and installed-client bundles;
- separately inventory Rust/Tauri crates and their license metadata;
- confirm attribution/notice/source-offer obligations where applicable;
- preserve the exact lockfiles reviewed;
- have buyer/seller counsel or qualified license reviewer approve the final distribution model.

No statement in this file asserts that a particular license is incompatible with Korvi's proprietary distribution model. That determination depends on actual linking, modification, distribution and deployment facts.
