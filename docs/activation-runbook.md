# Activation runbook

Activation is intentionally separate from repository implementation.

1. Glen approves the GitHub Team purchase and confirms the organization still has the expected seats.
2. Authenticate with organization-administration and custom-property administration permission.
3. Apply `governance/custom-property-schema.json` to `PATCH /orgs/LAAA-Deploys/properties/schema`.
4. Merge and protect this repository's `master` branch so the trusted workflow and manifest cannot be changed directly.
5. Import `governance/ruleset-walnut-canary.json`, set Walnut's explicit `laaa-deliverable=om`, and run the clean/failure PR canaries.
6. Verify Codex and Bugbot both respond on the unchanged canary head. Resolve every conversation.
7. After Glen approves the canary evidence, replace the Walnut-only ruleset with `governance/ruleset-property-fleet.json` and classify repositories in controlled batches.

The payloads have no bypass actors. Temporary ruleset disablement is an emergency action requiring Glen's explicit approval and immediate restoration after the corrective PR.
