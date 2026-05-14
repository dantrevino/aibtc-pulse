# Prepared Contributions for aibtcdev/aibtc-projects

## Issue #41 — Missing: TypeScript configuration (tsconfig.json)

**File:** `tsconfig.json`
**Description:** Adds a TypeScript configuration file (`tsconfig.json`) to enable type checking for JavaScript files via JSDoc annotations (`checkJs: true`). This provides editor IntelliSense, type validation, and strict mode enforcement without requiring TypeScript compilation — Cloudflare Pages uses plain JS at runtime.

Key settings:
- `target: es2022` — matches Cloudflare Workers runtime
- `moduleResolution: bundler` — compat with wrangler/esbuild
- `checkJs: true` — type-checks existing JS files
- `strict: true` — enables full strict checks
- `@cloudflare/workers-types` — provides `Request`, `Response`, `KVNamespace`, etc.

### How to submit
```bash
cp tsconfig.json ../../
git add tsconfig.json
git commit -m "chore: add tsconfig.json with strict checks for JS files"
```

---

## Issue #42 — Migrate wrangler.toml to wrangler.jsonc

**File:** `wrangler.jsonc`
**Description:** Migrates `wrangler.toml` to `wrangler.jsonc` (Cloudflare-recommended format). JSONC supports comments, trailing commas, and is easier to validate programmatically.

Changes:
- Remove `wrangler.toml`
- Add `wrangler.jsonc` with equivalent configuration
- Includes `$schema` for IDE autocompletion

### Migration steps
1. Add `wrangler.jsonc`
2. Delete `wrangler.toml`
3. Update any CI/CD references if needed

### How to submit
```bash
cp wrangler.jsonc ../../
rm ../../wrangler.toml
git add wrangler.jsonc
git add -u  # stages the deletion of wrangler.toml
git commit -m "chore: migrate wrangler.toml to wrangler.jsonc"
```
