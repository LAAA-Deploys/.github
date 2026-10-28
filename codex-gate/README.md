# Codex review gate

The `codex-review` commit status for every LAAA repo on the gate. The rule and the logic are in
[`gate.mjs`](gate.mjs); the tests in [`gate.test.mjs`](gate.test.mjs). How a chat merges a PR,
and which repos are on the gate: laaa-agent-config `README.md` step 5.

Each repo on the gate carries one small workflow, `.github/workflows/codex-review.yml`, that calls
this action pinned to a full commit SHA of this repo. To change the gate: PR here, then a PR in
each repo moving the pin to the new SHA.

Two more rules since 10/27/2026. A Codex thread left open for an hour with no newer commit turns the
status to failure, "needs attention", and the workflow tags Glen (the PR watcher's sweep catches it).
And a finding nobody answers goes to the Codex responder,
[`.github/workflows/codex-responder.yml`](../.github/workflows/codex-responder.yml), a reusable
workflow each gated repo calls: at once from the comment event when a bot opened the PR (no chat owns
it), and by a dispatch from the watcher's sweep when a thread on any PR has had no reply from a person
for 30 minutes (`RESPOND_MS`), after the chat that opened it had its chance (laaa-agent-config README
step 5). It fixes a real defect on the PR branch and pushes, or replies why not, then resolves the thread.

This repo is on the gate too (`.github/workflows/codex-review.yml`), since it holds the gate.
Its own pin moves in the same PR as a change here, or in the next one.
