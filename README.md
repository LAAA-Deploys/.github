# LAAA-Deploys governance

Public home for approved LAAA marketing brand assets and trusted quality controls.

- `branding/logo_manifest.json` pins the approved source files, byte counts, SHA-256 hashes, dimensions, and allowed contexts.
- `scripts/validate_marketing_site.py` audits the full committed static tree without running site-controlled code.
- `scripts/run_browser_checks.cjs` serves committed output with outbound browser traffic blocked and checks the required responsive/accessibility matrix.
- `.github/workflows/laaa-marketing-quality.yml` exposes the aggregate `laaa-marketing-quality` check for organization enforcement.
- `tests/run_canaries.cjs` proves that altered/embedded logos, nested or synthesized wordmarks, collisions, narrow overflow, broken menu semantics, missing HTML/CSS assets, alternate HTML routes, missing hero hooks, and outbound dependencies fail while clean fixtures pass.

Organization rulesets, required custom properties, Bugbot enablement, merges, and Pages-source changes remain separate approval-gated settings. See [the site contract](docs/site-contract.md).
