// The gate's verdicts on fixed GitHub data, no network:  node --test codex-gate/
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, commentFor, STALL_MS, THREAD_MS, RESPOND_MS } from "./gate.mjs";

const NOW = Date.parse("2026-10-26T20:00:00Z");
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const HEAD = "f".repeat(40);
const OLD = "e".repeat(40);
const CODEX = { login: "chatgpt-codex-connector[bot]", type: "Bot" };
const GLEN = { login: "gscher1311", type: "User" };
const ACTIONS = { login: "github-actions[bot]", type: "Bot" };
const FAKE = { login: "chatgpt-codex-connector", type: "User" };

const summary = (status, sha, findings, updatedMin = 2) => ({
  id: 1, user: CODEX, created_at: ago(60), updated_at: ago(updatedMin),
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${sha}","has_any_findings":${findings},"status":"${status}"}} -->`,
});
const review = (id, sha, user = CODEX) => ({ id, user, commit_id: sha });
const finding = (id, reviewId, p) => ({ id, user: CODEX, pull_request_review_id: reviewId, body: `**![P${p} Badge](x) Fix this**` });
const status = (min) => ({ context: "codex-review", state: "pending", created_at: ago(min) });
const comment = (user, body, min) => ({ id: 100 + min, user, body, created_at: ago(min) });

const run = ({ pr = {}, issueComments = [], reviews = [], inline = [], statuses = [status(20)] } = {}) =>
  evaluate({ pr: { head: { sha: HEAD }, draft: false, ...pr }, issueComments, reviews, inline, statuses }, NOW);

test("a completed review of the head with no findings passes", () => {
  const v = run({ issueComments: [summary("completed", HEAD, false)] });
  assert.equal(v.result, "success");
});

test("a review of an older commit does not count for the new head", () => {
  const v = run({ issueComments: [summary("completed", OLD, false)], reviews: [review(9, OLD)], inline: [finding(5, 9, 1)], statuses: [status(3)] });
  assert.equal(v.result, "pending");
  assert.equal(v.action, null);
});

test("a finding before the summary completes is not a finished review", () => {
  const v = run({ issueComments: [summary("running", HEAD, null)], reviews: [review(9, HEAD)], inline: [finding(5, 9, 2)] });
  assert.equal(v.result, "pending");
});

test("a plain-comment finding posted before the gate first looked still counts", () => {
  const early = { id: 51, user: CODEX, created_at: ago(30), body: "**![P1 Badge](x) Real finding**" };
  const v = evaluate({ pr: { head: { sha: HEAD }, draft: false }, issueComments: [summary("completed", HEAD, true), early], reviews: [], inline: [],
    statuses: [status(3)], headCommit: { commit: { committer: { date: ago(40) } } } }, NOW);
  assert.equal(v.result, "failure");
});

test("a P1 on the head blocks; a P2 on the head passes the gate", () => {
  let v = run({ issueComments: [summary("completed", HEAD, true)], reviews: [review(9, HEAD)], inline: [finding(5, 9, 1)] });
  assert.equal(v.result, "failure");
  v = run({ issueComments: [summary("completed", HEAD, true)], reviews: [review(9, HEAD)], inline: [finding(5, 9, 2)] });
  assert.equal(v.result, "success");
});

test("a P1 on an older commit stops blocking once Codex reviews the fix clean", () => {
  const v = run({ issueComments: [summary("completed", HEAD, false)], reviews: [review(8, OLD), review(9, HEAD)], inline: [finding(5, 8, 1)] });
  assert.equal(v.result, "success");
});

test("completed with findings waits until the findings are readable", () => {
  const v = run({ issueComments: [summary("completed", HEAD, true, 0.1)] });
  assert.equal(v.result, "pending");
});

test("only the Codex bot counts: a look-alike account is ignored", () => {
  const fake = { ...summary("completed", HEAD, false), user: FAKE };
  const v = run({ issueComments: [fake], statuses: [status(3)] });
  assert.equal(v.result, "pending");
});

test("a failed review asks once at once; a stall asks once after the wait", () => {
  let v = run({ issueComments: [summary("failed", HEAD, null)] });
  assert.equal(v.action, "retry");
  v = run({ statuses: [status(STALL_MS / 60000 - 1)] });
  assert.equal(v.action, null);
  v = run({ statuses: [status(STALL_MS / 60000 + 1)] });
  assert.equal(v.action, "retry");
  assert.equal(v.result, "pending");
});

test("after one retry, a second stall fails the gate and tags Glen once", () => {
  const retry = comment(ACTIONS, commentFor("retry", HEAD), STALL_MS / 60000 + 1);
  let v = run({ issueComments: [retry], statuses: [status(60)] });
  assert.equal(v.result, "failure");
  assert.equal(v.action, "attention");
  const notice = comment(ACTIONS, commentFor("attention", HEAD), 1);
  v = run({ issueComments: [retry, notice], statuses: [status(60)] });
  assert.equal(v.result, "failure");
  assert.equal(v.action, null);
});

test("a person's own @codex review counts as the one retry", () => {
  const v = run({ issueComments: [comment(GLEN, "@codex review", 2)], statuses: [status(30)] });
  assert.equal(v.result, "pending");
  assert.equal(v.action, null);
});

test("a retry for an older head does not use up the new head's retry", () => {
  const v = run({ issueComments: [comment(ACTIONS, commentFor("retry", OLD), 40)], statuses: [status(STALL_MS / 60000 + 1)] });
  assert.equal(v.action, "retry");
});

test("the review arriving after the retry passes", () => {
  const retry = comment(ACTIONS, commentFor("retry", HEAD), 20);
  const v = run({ issueComments: [retry, summary("completed", HEAD, false)], statuses: [status(60)] });
  assert.equal(v.result, "success");
});

test("a draft waits", () => {
  const v = run({ pr: { draft: true } });
  assert.equal(v.result, "pending");
  assert.equal(v.action, null);
});

// The two runners against a recording fake GitHub.
import { applyEvent, applySweep } from "./gate.mjs";
function fakeApi(data) {
  const posts = [];
  return {
    posts,
    get: async (p) => data[p.replace(/\?.*$/, "")] ?? [],
    post: async (p, body) => { posts.push([p, body]); return {}; },
  };
}
const base = (statuses, issueComments = []) => ({
  "repos/o/r/pulls": [{ number: 7, draft: false }],
  "repos/o/r/pulls/7": { number: 7, state: "open", draft: false, head: { sha: HEAD }, base: { repo: { default_branch: "main" } }, html_url: "u" },
  "repos/o/r/issues/7/comments": issueComments,
  [`repos/o/r/commits/${HEAD}/statuses`]: statuses,
});

test("the workflow posts a changed status once and never the retry without a comment token", async () => {
  const api = fakeApi(base([{ ...status(STALL_MS / 60000 + 1), description: "old" }]));
  await applyEvent({ api, repo: "o/r", n: 7, log: () => {} });
  assert.deepEqual(api.posts.map(([p]) => p), [`repos/o/r/statuses/${HEAD}`]);
});

test("the workflow tags Glen when the retry also stalled", async () => {
  const retry = comment(GLEN, commentFor("retry", HEAD), STALL_MS / 60000 + 1);
  const api = fakeApi(base([status(60)], [retry]));
  await applyEvent({ api, repo: "o/r", n: 7, log: () => {} });
  const tag = api.posts.find(([p]) => p.endsWith("/issues/7/comments"));
  assert.match(tag[1].body, /@gscher1311/);
});

test("the watcher posts the retry and wakes the workflow, and never posts a status", async () => {
  const api = fakeApi(base([status(STALL_MS / 60000 + 1)]));
  await applySweep({ api, repo: "o/r", log: () => {} });
  const paths = api.posts.map(([p]) => p);
  assert.ok(paths.includes("repos/o/r/issues/7/comments"));
  assert.ok(paths.includes("repos/o/r/actions/workflows/codex-review.yml/dispatches"));
  assert.ok(!paths.some((p) => p.includes("/statuses/")));
});

test("a repo's exempt bot passes only when every file is under its paths", () => {
  const exempt = { author: "app/records-bot", paths: ["records/_generated/"] };
  const pr = { user: { login: "app/records-bot" } };
  let v = run({ pr, statuses: [status(3)] });
  assert.equal(v.result, "pending");
  v = evaluate({ pr: { head: { sha: HEAD }, draft: false, ...pr }, issueComments: [], reviews: [], inline: [], statuses: [status(3)],
    files: [{ filename: "records/_generated/a.md" }], exempt }, NOW);
  assert.equal(v.result, "success");
  v = evaluate({ pr: { head: { sha: HEAD }, draft: false, ...pr }, issueComments: [], reviews: [], inline: [], statuses: [status(3)],
    files: [{ filename: "records/_generated/a.md" }, { filename: "scripts/x.py" }], exempt }, NOW);
  assert.equal(v.result, "pending");
  v = evaluate({ pr: { head: { sha: HEAD }, draft: false, user: { login: "someone" } }, issueComments: [], reviews: [], inline: [], statuses: [status(3)],
    files: [{ filename: "records/_generated/a.md" }], exempt }, NOW);
  assert.equal(v.result, "pending");
});

test("the watcher skips a head the workflow already passed", async () => {
  const api = fakeApi(base([{ ...status(STALL_MS / 60000 + 1), state: "success", description: "ok" }]));
  await applySweep({ api, repo: "o/r", log: () => {} });
  assert.equal(api.posts.length, 0);
});

test("a plain-comment finding does not count for the head while the summary names an older commit", () => {
  const late = { id: 50, user: CODEX, created_at: ago(1), body: "**![P2 Badge](x) Old head finding**" };
  const v = run({ issueComments: [summary("completed", OLD, true), late], statuses: [status(3)] });
  assert.equal(v.result, "pending");
});

test("a completed summary with no review on the head after the settle window is a clean review", () => {
  const v = run({ issueComments: [summary("completed", HEAD, true, 2)], statuses: [status(60)] });
  assert.equal(v.result, "success");
});

test("a clean summary on the head outranks a late plain-comment finding from the previous review", () => {
  const late = { id: 52, user: CODEX, created_at: ago(1), body: "**![P1 Badge](x) Old review finding**" };
  const v = evaluate({ pr: { head: { sha: HEAD }, draft: false }, issueComments: [summary("completed", HEAD, false), late], reviews: [], inline: [],
    statuses: [status(3)], headCommit: { commit: { committer: { date: ago(10) } } } }, NOW);
  assert.equal(v.result, "success");
});

test("one PR's failed dispatch is logged and the sweep goes on", async () => {
  const api = fakeApi(base([status(STALL_MS / 60000 + 1)]));
  api.post = async (p) => { if (p.includes("/dispatches")) throw new Error("HTTP 404"); return {}; };
  const lines = [];
  const failed = await applySweep({ api, repo: "o/r", log: (l) => lines.push(l) });
  assert.equal(failed, 1);
  assert.match(lines[0], /failed: HTTP 404/);
});

test("a 'Fixed' reply on a finding raised on the head, with no later commit, fails the gate", () => {
  const reply = (id, to, body) => ({ id, user: GLEN, in_reply_to_id: to, body });
  const base2 = { issueComments: [summary("completed", HEAD, true)], reviews: [review(9, HEAD)] };
  let v = run({ ...base2, inline: [finding(5, 9, 2), reply(6, 5, "Fixed in abc1234.")] });
  assert.equal(v.result, "failure");
  v = run({ ...base2, inline: [finding(5, 9, 2), reply(6, 5, "Fixed in PR #12.")] });
  assert.equal(v.result, "success");
  v = run({ ...base2, inline: [finding(5, 9, 2), reply(6, 5, "Skipped: out of scope.")] });
  assert.equal(v.result, "success");
});

test("a 'Fixed' reply on an older commit's finding passes once Codex reviewed the fix commit clean", () => {
  const reply = { id: 6, user: GLEN, in_reply_to_id: 5, body: "Fixed in fffffff." };
  const v = run({ issueComments: [summary("completed", HEAD, false)], reviews: [review(8, OLD), review(9, HEAD)], inline: [finding(5, 8, 2), reply] });
  assert.equal(v.result, "success");
});

test("a clean re-review of a PR that once had findings passes once settled with no head review", () => {
  const sum = { id: 1, user: CODEX, created_at: ago(60), updated_at: ago(2),
    body: `<!-- codex-pull-request-review-summary -->
<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${HEAD}","has_any_findings":true,"has_unresolved_findings":false,"status":"completed"}} -->` };
  const v = run({ issueComments: [sum], reviews: [review(8, OLD)], inline: [finding(5, 8, 2)] });
  assert.equal(v.result, "success");
});

test("a P2 on the head waits until its thread is resolved, then passes", () => {
  const base2 = { issueComments: [summary("completed", HEAD, true)], reviews: [review(9, HEAD)], inline: [finding(5, 9, 2)] };
  let v = evaluate({ pr: { head: { sha: HEAD }, draft: false }, ...base2, statuses: [status(20)], threads: new Map([[5, false]]) }, NOW);
  assert.equal(v.result, "pending");
  assert.equal(v.action, null);
  v = evaluate({ pr: { head: { sha: HEAD }, draft: false }, ...base2, statuses: [status(20)], threads: new Map([[5, true]]) }, NOW);
  assert.equal(v.result, "success");
});

test("right after completion with findings flagged, the gate waits for the review to post", () => {
  const sum = { id: 1, user: CODEX, created_at: ago(60), updated_at: new Date(NOW - 10000).toISOString(),
    body: `<!-- codex-pull-request-review-summary -->
<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${HEAD}","has_any_findings":true,"has_unresolved_findings":true,"status":"completed"}} -->` };
  const v = run({ issueComments: [sum] });
  assert.equal(v.result, "pending");
  assert.equal(v.settling, true);
});

test("a clean head still waits while an older commit's Codex thread is open (laaa-platform #415)", () => {
  const base2 = { issueComments: [summary("completed", HEAD, false)], reviews: [review(8, OLD), review(9, HEAD)], inline: [finding(5, 8, 1)] };
  let v = evaluate({ pr: { head: { sha: HEAD }, draft: false }, ...base2, statuses: [status(20)], threads: new Map([[5, false]]) }, NOW);
  assert.equal(v.result, "pending");
  assert.match(v.description, /1 Codex thread\(s\) still open/);
  v = evaluate({ pr: { head: { sha: HEAD }, draft: false }, ...base2, statuses: [status(20)], threads: new Map([[5, true]]) }, NOW);
  assert.equal(v.result, "success");
});

test("a Codex thread open for an hour with no newer commit fails the gate and tags Glen once", () => {
  const old = (min) => ({ id: 5, user: CODEX, pull_request_review_id: 9, created_at: ago(min), body: "**![P2 Badge](x) Fix this**" });
  const base = (min) => ({ issueComments: [summary("completed", HEAD, true)], reviews: [review(9, HEAD)], inline: [old(min)] });
  const head = { commit: { committer: { date: ago(120) } } };
  const at = (min, extra = {}, headCommit = head) => evaluate({ pr: { head: { sha: HEAD }, draft: false }, ...base(min), ...extra,
    statuses: [status(20)], threads: new Map([[5, false]]), headCommit }, NOW);
  let v = at(THREAD_MS / 60000 - 5);
  assert.equal(v.result, "pending");
  assert.equal(v.action, null);
  v = at(THREAD_MS / 60000 + 5);
  assert.equal(v.result, "failure");
  assert.equal(v.action, "threads");
  assert.match(v.description, /open over an hour/);
  const notice = comment(ACTIONS, commentFor("threads", HEAD, 1), 1);
  assert.match(notice.body, /@gscher1311 1 Codex thread/);
  v = at(THREAD_MS / 60000 + 5, { issueComments: [summary("completed", HEAD, true), notice] });
  assert.equal(v.result, "failure");
  assert.equal(v.action, null);
  // A push after the thread restarts the clock: the head commit is newer than the open thread.
  v = at(THREAD_MS / 60000 + 5, {}, { commit: { committer: { date: ago(10) } } });
  assert.equal(v.result, "pending");
});

test("a thread unanswered for half an hour is handed to the responder; one a person answered is not", () => {
  const root = (min) => ({ id: 5, user: CODEX, pull_request_review_id: 9, created_at: ago(min), body: "**![P2 Badge](x) Fix this**" });
  const head = { commit: { committer: { date: ago(120) } } };
  const at = (min, inline) => evaluate({ pr: { head: { sha: HEAD }, draft: false }, issueComments: [summary("completed", HEAD, true)],
    reviews: [review(9, HEAD)], inline, statuses: [status(20)], threads: new Map([[5, false]]), headCommit: head }, NOW);
  let v = at(RESPOND_MS / 60000 - 5, [root(RESPOND_MS / 60000 - 5)]);
  assert.equal(v.result, "pending");
  assert.deepEqual(v.respond, []);
  v = at(RESPOND_MS / 60000 + 5, [root(RESPOND_MS / 60000 + 5)]);
  assert.equal(v.result, "pending");
  assert.deepEqual(v.respond, [5]);
  const reply = { id: 6, user: GLEN, in_reply_to_id: 5, created_at: ago(2), body: "Not a defect: the flag is parsed upstream." };
  v = at(RESPOND_MS / 60000 + 5, [root(RESPOND_MS / 60000 + 5), reply]);
  assert.deepEqual(v.respond, []);
  // Past an hour it still names the thread, beside the tag for Glen.
  v = at(THREAD_MS / 60000 + 5, [root(THREAD_MS / 60000 + 5)]);
  assert.equal(v.result, "failure");
  assert.deepEqual(v.respond, [5]);
});
