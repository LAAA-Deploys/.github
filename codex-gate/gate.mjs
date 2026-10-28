// The Codex review gate for every LAAA repo (Glen, 10/26/2026). It posts the commit status
// `codex-review` on a PR's head; branch protection requires that status, so GitHub refuses a
// merge until Codex has reviewed the exact commit being merged.
//
// The rule:
//   - Codex's completed review must be on the PR's current head commit. A new push resets the
//     status to pending until Codex reviews that commit (Codex is set to review on every push).
//   - A P0 or P1 finding on the head blocks. Fix it and push; Codex reviews the new head. A
//     rebutted false positive passes only on Glen's own "force merge #N" (laaa-agent-config README).
//   - Every other finding passes the gate; its thread is answered and resolved, which GitHub's
//     required conversation resolution enforces. A thread left open for THREAD_MS with no newer
//     commit turns the status to failure and tags Glen, so no PR sits silently (10/27/2026: Codex
//     posts after the chat that opened the PR has stopped, and nothing else was listening).
//   - A review that failed, or made no progress for STALL_MS, is asked for once more. If that one
//     also fails or stalls, the status turns to failure and Glen is tagged on the PR, so GitHub
//     notifies him. Nothing ever passes without a review.
//
// Two entry points, and neither checks out or runs anything from the PR:
//   --event: a repo's codex-review workflow, on PR and comment events and on a dispatch. It alone
//     posts the status (branch protection takes it only from GitHub Actions) and the tag for Glen
//     (a mention from the workflow's bot notifies him; one from his own account would not).
//   --sweep owner/repo ...: the PR watcher on Glen's PC (laaa-agent-config scripts/pr-watcher.ps1),
//     which catches the stalls no event reports. It runs as Glen, because Codex answers a review
//     request from a person: it posts the one retry, and dispatches the repo's workflow when the
//     verdict has moved, so the workflow posts the status and any tag.

export const CONTEXT = "codex-review";
export const STALL_MS = 15 * 60 * 1000;
// An open Codex thread with no reply from a person and no newer commit: after RESPOND_MS the watcher's
// sweep dispatches the repo's codex-responder workflow for it (a chat's own PR had its chance; a bot's
// PR got the responder at once from the comment event); after THREAD_MS the gate fails and tags Glen.
export const RESPOND_MS = 30 * 60 * 1000;
export const THREAD_MS = 60 * 60 * 1000;
// Codex posts a run's findings within seconds of marking its summary completed.
export const SETTLE_MS = 45 * 1000;
export const CODEX_LOGIN = "chatgpt-codex-connector[bot]";
export const NOTIFY = "@gscher1311";

const isCodex = (u) => u?.login === CODEX_LOGIN && u?.type === "Bot";
const isBot = (u) => u?.type === "Bot" || /\[bot\]$/i.test(u?.login ?? "");
const t = (s) => (s ? new Date(s).getTime() : 0);
const short = (sha) => sha.slice(0, 7);
const severity = (body) => (body ?? "").match(/!\[P([0-3]) Badge\]/)?.[1] ?? null;
const retryMarker = (sha) => `<!-- codex-gate:retry ${sha} -->`;
const attentionMarker = (sha) => `<!-- codex-gate:attention ${sha} -->`;
const threadsMarker = (sha) => `<!-- codex-gate:threads ${sha} -->`;

export function codexState(summary) {
  const m = (summary?.body ?? "").match(/codex-review-state:v1\s*(\{.*?\})\s*-->/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1])?.code_review ?? null;
  } catch {
    return null;
  }
}

// data: { pr, issueComments, reviews, inline, statuses } as GitHub returns them.
// Returns { result, description, action } where action is null, "retry" or "attention".
export function evaluate({ pr, issueComments, reviews, inline, statuses, headCommit = null, threads = null, files = null, exempt = null }, now = Date.now()) {
  const head = pr.head.sha;
  // A repo may exempt one bot's generated data (buildium-assistant's daily records PRs): the PR's
  // author must be exactly that bot and every changed file must sit under one of its paths.
  if (exempt?.author && pr.user?.login === exempt.author && Array.isArray(files) && files.length &&
      files.every((f) => exempt.paths.some((p) => f.filename.startsWith(p)) &&
        (!f.previous_filename || exempt.paths.some((p) => f.previous_filename.startsWith(p))))) {
    return { result: "success", description: `Generated data from ${exempt.author}, exempt from review.`, action: null };
  }
  const mine = statuses.filter((s) => s.context === CONTEXT);
  // The clock for this head starts when the gate first saw it (its first status on the commit).
  const since = mine.length ? Math.min(...mine.map((s) => t(s.created_at))) : now;

  if (pr.draft) return { result: "pending", description: "Draft: Codex reviews when the PR is marked ready.", action: null };

  const summary = issueComments.find((c) => isCodex(c.user) && /codex-pull-request-review-summary/.test(c.body ?? ""));
  const state = codexState(summary);
  const onHead = state?.commit_sha === head;
  const status = (state?.status ?? "").toLowerCase();

  const headReviewIds = new Set(reviews.filter((r) => isCodex(r.user) && r.commit_id === head).map((r) => r.id));
  // Inline findings carry their review's commit. A finding posted as a plain comment carries none, so
  // it counts only while the summary names the head and only if it is newer than the head commit
  // (Codex findings on .github #3). A head summary that says it found nothing outranks any such comment.
  const headTime = t(headCommit?.commit?.committer?.date);
  const headFindings = [
    ...inline.filter((c) => isCodex(c.user) && !c.in_reply_to_id && headReviewIds.has(c.pull_request_review_id)),
    ...issueComments.filter((c) => onHead && state.has_any_findings !== false && isCodex(c.user) && c !== summary && t(c.created_at) >= headTime),
  ].filter((c) => severity(c.body) !== null);
  const blocking = headFindings.filter((c) => Number(severity(c.body)) <= 1);

  // Done only when the summary says the review of the head completed. Codex flips it a few seconds
  // before its findings post, so a completed review that says it has findings counts once they are
  // readable; a finding alone, before the summary completes, is not a finished review.
  // has_any_findings and has_unresolved_findings count the whole PR, older commits included, so a clean
  // re-review of a PR that once had findings still says true (#333 and .github #6, 10/26/2026). A run
  // with findings posts a review on the head within seconds; none SETTLE_MS after completion is clean.
  const settled = onHead && now - t(summary.updated_at) > SETTLE_MS;
  const completed = onHead && status === "completed" &&
    (state.has_any_findings === false || headFindings.length > 0 || (settled && headReviewIds.size === 0));

  if (completed) {
    if (blocking.length) {
      return {
        result: "failure",
        description: `Codex found ${blocking.length} P0/P1 on ${short(head)}: fix and push (Codex re-reviews), or Glen's "force merge".`,
        action: null,
      };
    }
    // A finding Codex raised on the head commit cannot have been fixed yet: no commit came after it.
    // A reply on its thread that says "Fixed" (other than "Fixed in PR #n", fixed elsewhere) means the
    // fix never landed, so the gate fails until it is pushed or the reply says what really happened.
    const claimedFixed = headFindings.filter((f) => f.pull_request_review_id && inline.some((r) =>
      r.in_reply_to_id === f.id && !isBot(r.user) && /^\W*fixed\b/i.test((r.body ?? "").trim()) && !/\bPR #\d+/i.test(r.body ?? "")));
    if (claimedFixed.length) {
      return {
        result: "failure",
        description: `${claimedFixed.length} thread(s) on ${short(head)} say fixed, but no commit came after the finding: push the fix.`,
        action: null,
      };
    }
    // Every Codex thread on the PR, on any commit, is answered and resolved before the gate passes:
    // branch protection requires conversation resolution, so a gate that passed with an older thread open
    // showed green on a PR that could not merge (laaa-platform #415, 10/26/2026). Resolving a thread starts
    // no workflow run (a review-comment event would run the PR's own copy of the workflow), so the PR
    // watcher rechecks within 15 minutes, or a chat runs the workflow. threads: root comment id -> resolved.
    const open = threads ? inline.filter((c) => isCodex(c.user) && !c.in_reply_to_id && threads.get(c.id) === false) : [];
    if (open.length) {
      // Open for an hour with no push after the newest thread: nobody is answering. Fail and tag Glen
      // once per head, the same path a twice-stalled review takes; a push resets the head and the clock.
      const newest = Math.max(headTime, ...open.map((c) => t(c.created_at)));
      // Threads nobody has answered after RESPOND_MS: the sweep hands each to the responder (ids of the roots).
      const respond = open.filter((c) => t(c.created_at) && now - Math.max(headTime, t(c.created_at)) > RESPOND_MS &&
        !inline.some((r) => r.in_reply_to_id === c.id && !isBot(r.user))).map((c) => c.id);
      if (newest && now - newest > THREAD_MS) {
        const noticedThreads = issueComments.some((c) => (c.body ?? "").includes(threadsMarker(head)));
        return {
          result: "failure",
          description: `Needs attention: ${open.length} Codex thread(s) open over an hour on ${short(head)} with no newer commit. Glen is tagged.`,
          action: noticedThreads ? null : "threads",
          open: open.length,
          respond,
        };
      }
      return {
        result: "pending",
        description: `Codex reviewed ${short(head)}; ${open.length} Codex thread(s) still open: reply on and resolve each.`,
        action: null,
        respond,
      };
    }
    const n = headFindings.length;
    return {
      result: "success",
      description: n ? `Codex reviewed ${short(head)}; ${n} finding(s) answered and resolved.` : `Codex reviewed ${short(head)}, no findings.`,
      action: null,
    };
  }

  // Not reviewed yet. One more ask per head, by the gate or by a person; then a person.
  const retries = issueComments.filter((c) => (c.body ?? "").includes(retryMarker(head)) ||
    (!isBot(c.user) && /@codex (?:review|security review)/i.test(c.body ?? "") && t(c.created_at) >= since));
  const retryAt = retries.length ? Math.max(...retries.map((c) => t(c.created_at))) : 0;
  const noticed = issueComments.some((c) => (c.body ?? "").includes(attentionMarker(head)));
  const failedAt = onHead && status === "failed" ? t(summary.updated_at) : 0;
  const lastProgress = Math.max(since, retryAt, onHead ? t(summary.updated_at) : 0);
  const stalled = now - lastProgress > STALL_MS;

  // Findings that never become readable fall into the stall path like any other missing review.
  if (onHead && status === "completed" && !stalled) {
    return { result: "pending", description: `Codex finished ${short(head)}; reading its findings.`, action: null, settling: true };
  }
  if (!retryAt) {
    if (failedAt || stalled) {
      return { result: "pending", description: `Codex ${failedAt ? "failed" : "stalled"} on ${short(head)}; asking once more.`, action: "retry" };
    }
    return { result: "pending", description: `Waiting for Codex to review ${short(head)}.`, action: null };
  }
  if (failedAt > retryAt || stalled) {
    return {
      result: "failure",
      description: `Needs attention: Codex did not finish ${short(head)} after one retry. Glen is tagged on the PR.`,
      action: noticed ? null : "attention",
    };
  }
  return { result: "pending", description: `Asked Codex again; waiting for its review of ${short(head)}.`, action: null };
}

export function commentFor(action, head, open = 0) {
  if (action === "retry") return `@codex review\n\n${retryMarker(head)}`;
  if (action === "threads") {
    return `${NOTIFY} ${open} Codex thread(s) on \`${short(head)}\` have been open for over an hour with no newer commit, so this PR ` +
      `cannot merge. Reply on each thread (push the fix first if there is one) and resolve it; the gate rechecks within 15 minutes, ` +
      `or \`gh workflow run codex-review.yml -f pr=<N>\` rechecks at once.\n\n${threadsMarker(head)}`;
  }
  return `${NOTIFY} Codex has not finished reviewing \`${short(head)}\` after one retry, so this PR cannot merge. ` +
    `Check Codex for this repo (usage limits, setup), then push a commit or comment \`@codex review\`.\n\n${attentionMarker(head)}`;
}

// --- GitHub entry points ----------------------------------------------------------------------
function client(token) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const call = async (url, init = {}) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
      if (res.ok || (res.status < 500 && res.status !== 429) || attempt === 2) return res;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  };
  return {
    async get(path) {
      let url = `https://api.github.com/${path}${path.includes("?") ? "&" : "?"}per_page=100`;
      let out = null;
      while (url) {
        const res = await call(url);
        if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
        const body = await res.json();
        if (!Array.isArray(body)) return body;
        out = (out ?? []).concat(body);
        url = (res.headers.get("link") ?? "").match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
      }
      return out;
    },
    async graphql(query, variables) {
      const res = await call("https://api.github.com/graphql", { method: "POST", body: JSON.stringify({ query, variables }) });
      const body = await res.json();
      if (!res.ok || body.errors) throw new Error(`GraphQL: HTTP ${res.status} ${JSON.stringify(body.errors ?? body)}`);
      return body.data;
    },
    async post(path, body) {
      const res = await call(`https://api.github.com/${path}`, { method: "POST", body: JSON.stringify(body) });
      const text = await res.text();
      if (!res.ok) throw new Error(`POST ${path}: HTTP ${res.status} ${text}`);
      return text ? JSON.parse(text) : {}; // a workflow dispatch answers 204 with no body
    },
  };
}

export async function gather(api, repo, n, exempt = null) {
  const pr = await api.get(`repos/${repo}/pulls/${n}`);
  const [issueComments, reviews, inline, statuses, headCommit, files] = await Promise.all([
    api.get(`repos/${repo}/issues/${n}/comments`),
    api.get(`repos/${repo}/pulls/${n}/reviews`),
    api.get(`repos/${repo}/pulls/${n}/comments`),
    api.get(`repos/${repo}/commits/${pr.head.sha}/statuses`),
    api.get(`repos/${repo}/commits/${pr.head.sha}`),
    exempt?.author && pr.user?.login === exempt.author ? api.get(`repos/${repo}/pulls/${n}/files`) : null,
  ]);
  let threads = null;
  if (api.graphql) {
    const [owner, name] = repo.split("/");
    const q = "query($o:String!,$n:String!,$p:Int!,$a:String){repository(owner:$o,name:$n){pullRequest(number:$p){" +
      "reviewThreads(first:100,after:$a){pageInfo{hasNextPage endCursor} nodes{isResolved comments(first:1){nodes{databaseId}}}}}}}";
    threads = new Map();
    for (let after = null; ;) {
      const page = (await api.graphql(q, { o: owner, n: name, p: Number(n), a: after })).repository.pullRequest.reviewThreads;
      for (const t of page.nodes) threads.set(t.comments.nodes[0]?.databaseId, t.isResolved);
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
  }
  return { pr, issueComments, reviews, inline, statuses, headCommit, threads, files, exempt };
}

// From the workflow's inputs: EXEMPT_AUTHOR (a bot login) and EXEMPT_PATHS (comma-separated prefixes).
export function exemptFromEnv(env) {
  const author = (env.EXEMPT_AUTHOR ?? "").trim();
  const paths = (env.EXEMPT_PATHS ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  return author && paths.length ? { author, paths } : null;
}

const describe = (status) => (status ? `${status.state}|${status.description}` : "");

// The workflow's run: post the status when it changed, and the tag for Glen once. The retry is the
// watcher's (it posts as a person), unless a comment token was given to the workflow.
export async function applyEvent({ api, commentApi = null, repo, n, exempt = null, log = console.log, pause = 15000 }) {
  let data = await gather(api, repo, n, exempt);
  if (data.pr.state !== "open") return;
  let v = evaluate(data);
  // Codex's findings post seconds after its summary says completed, with no event of their own:
  // look again for up to a minute rather than leave the status pending (apto-hub #328).
  for (let i = 0; i < 4 && v.settling; i++) {
    await new Promise((r) => setTimeout(r, pause));
    data = await gather(api, repo, n, exempt);
    v = evaluate(data);
  }
  const head = data.pr.head.sha;
  const latest = data.statuses.find((s) => s.context === CONTEXT); // newest first
  if (describe(latest) !== `${v.result}|${v.description.slice(0, 140)}`) {
    await api.post(`repos/${repo}/statuses/${head}`, {
      state: v.result, context: CONTEXT, description: v.description.slice(0, 140), target_url: data.pr.html_url,
    });
  }
  if (v.action === "attention" || v.action === "threads") {
    await api.post(`repos/${repo}/issues/${n}/comments`, { body: commentFor(v.action, head, v.open) });
  }
  if (v.action === "retry" && commentApi) await commentApi.post(`repos/${repo}/issues/${n}/comments`, { body: commentFor("retry", head) });
  log(`#${n} ${short(head)} ${v.result}${v.action ? " +" + v.action : ""}`);
}

// The watcher's pass over one repo: retry as a person, and wake the workflow when the verdict moved.
// One PR's failure (a repo without the workflow yet, a GitHub error) is logged and the rest go on;
// the return value is the number of PRs that failed.
export async function applySweep({ api, repo, log = console.log }) {
  const open = await api.get(`repos/${repo}/pulls?state=open`);
  let failed = 0;
  for (const p of open) {
    if (p.draft) continue;
    try {
      const data = await gather(api, repo, p.number);
      const head = data.pr.head.sha;
      const latest = data.statuses.find((s) => s.context === CONTEXT);
      // A head the workflow already passed needs nothing (a review, or a repo's exempt generated data).
      if (latest?.state === "success") continue;
      const v = evaluate(data);
      if (v.action === "retry") await api.post(`repos/${repo}/issues/${p.number}/comments`, { body: commentFor("retry", head) });
      // A thread unanswered for RESPOND_MS goes to the repo's responder, one dispatch per thread per sweep;
      // its reply ends the dispatches, and a repo without the workflow is logged and skipped.
      for (const id of v.respond ?? []) {
        try {
          await api.post(`repos/${repo}/actions/workflows/codex-responder.yml/dispatches`, { ref: data.pr.base.repo.default_branch, inputs: { pr: String(p.number), comment: String(id) } });
          log(`${repo}#${p.number} responder dispatched for thread ${id}`);
        } catch (e) {
          log(`${repo}#${p.number} responder dispatch for thread ${id} failed: ${e?.message ?? e}`);
        }
      }
      if (v.action === "attention" || v.action === "threads" || describe(latest) !== `${v.result}|${v.description.slice(0, 140)}`) {
        await api.post(`repos/${repo}/actions/workflows/codex-review.yml/dispatches`, { ref: data.pr.base.repo.default_branch, inputs: { pr: String(p.number) } });
      }
      log(`${repo}#${p.number} ${short(head)} ${v.result}${v.action ? " +" + v.action : ""}`);
    } catch (e) {
      failed++;
      log(`${repo}#${p.number} failed: ${e?.message ?? e}`);
    }
  }
  return failed;
}

async function main() {
  const fs = await import("node:fs");
  const api = client(process.env.GITHUB_TOKEN);
  const sweep = process.argv.indexOf("--sweep");
  if (sweep >= 0) {
    let failed = 0;
    for (const repo of process.argv.slice(sweep + 1)) {
      try {
        failed += await applySweep({ api, repo });
      } catch (e) {
        failed++;
        console.error(`${repo}: ${e?.message ?? e}`);
      }
    }
    if (failed) process.exitCode = 1;
    return;
  }
  const repo = process.env.GITHUB_REPOSITORY;
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const n = event.pull_request?.number ?? event.issue?.number ?? event.inputs?.pr;
  if (!n) return console.log("No pull request on this event.");
  const commentApi = process.env.COMMENT_TOKEN ? client(process.env.COMMENT_TOKEN) : null;
  await applyEvent({ api, commentApi, repo, n, exempt: exemptFromEnv(process.env) });
}

if (process.argv.includes("--event") || process.argv.includes("--sweep")) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
