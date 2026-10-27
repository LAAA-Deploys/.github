# Codex review gate

The `codex-review` commit status for every LAAA repo on the gate. The rule and the logic are in
[`gate.mjs`](gate.mjs); the tests in [`gate.test.mjs`](gate.test.mjs). How a chat merges a PR,
and which repos are on the gate: laaa-agent-config `README.md` step 5.

Each repo on the gate carries one small workflow, `.github/workflows/codex-review.yml`, that calls
this action pinned to a full commit SHA of this repo. To change the gate: PR here, then a PR in
each repo moving the pin to the new SHA.

A review that fails or stalls sends no GitHub event, so the PR watcher,
[`.github/workflows/pr-watcher.yml`](../.github/workflows/pr-watcher.yml), runs the gate's `--sweep`
every 15 minutes across the gated repos with Glen's token (the `WATCHER_TOKEN` secret): it asks Codex
once more and wakes a repo's workflow when the verdict moved. A repo added to the gate is added to its list.

This repo is on the gate too (`.github/workflows/codex-review.yml`), since it holds the gate.
Its own pin moves in the same PR as a change here, or in the next one.
