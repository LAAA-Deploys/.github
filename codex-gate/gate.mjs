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
//     required conversation resolution enforces.
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
export const CODEX_LOGIN = "chatgpt-codex-connector[bot]";
export const NOTIFY = "@gscher1311";

const isCodex = (u) => u?.login === CODEX_LOGIN && u?.type === "Bot";
const isBot = (u) => u?.type === "Bot" || /\[bot\]$/i.test(u?.login ?? "");
const t = (s) => (s ? new Date(s).getTime() : 0);
const short = (sha) => sha.slice(0, 7);
const severity = (body) => (body ?? "").match(/!\[P([0-3]) Badge\]/)?.[1] ?? null;
const retryMarker = (sha) => `<!-- codex-gate:retry ${sha} -->`;
const attentionMarker = (sha) => `<!-- codex-gate:attention ${sha} -->`;

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
export function evaluate({ pr, issueComments, reviews, inline, statuses }, now = Date.now()) {
  const head = pr.head.sha;
  const mine = statuses.filter((s) => s.context === CONTEXT);
  // The clock for this head starts when the gate first saw it (its first status on the commit).
  const since = mine.length ? Math.min(...mine.map((s) => t(s.created_at))) : now;

  if (pr.draft) return { result: "pending", description: "Draft: Codex reviews when the PR is marked ready.", action: null };

  const summary = issueComments.find((c) => isCodex(c.user) && /codex-pull-request-review-summary/.test(c.body ?? ""));
  const state = codexState(summary);
  const onHead = state?.commit_sha === head;
  const status = (state?.status ?? "").toLowerCase();

  const headReviewIds = new Set(reviews.filter((r) => isCodex(r.user) && r.commit_id === head).map((r) => r.id));
  const headFindings = [
    ...inline.filter((c) => isCodex(c.user) && !c.in_reply_to_id && headReviewIds.has(c.pull_request_review_id)),
    ...issueComments.filter((c) => isCodex(c.user) && c !== summary && severity(c.body) && t(c.created_at) >= since),
  ].filter((c) => severity(c.body) !== null);
  const blocking = headFindings.filter((c) => Number(severity(c.body)) <= 1);

  // Codex flips its summary to completed a few seconds before its findings post; a completed
  // review that says it has findings counts once they are readable (the next comment event).
  const completed = (onHead && status === "completed" && (state.has_any_findings === false || headFindings.length > 0)) ||
    headFindings.length > 0;

  if (completed) {
    if (blocking.length) {
      return {
        result: "failure",
        description: `Codex found ${blocking.length} P0/P1 on ${short(head)}: fix and push (Codex re-reviews), or Glen's "force merge".`,
        action: null,
      };
    }
    const n = headFindings.length;
    return {
      result: "success",
      description: n ? `Codex reviewed ${short(head)}; ${n} finding(s): answer and resolve each thread.` : `Codex reviewed ${short(head)}, no findings.`,
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

  if (onHead && status === "completed") {
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

export function commentFor(action, head) {
  if (action === "retry") return `@codex review\n\n${retryMarker(head)}`;
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
    async post(path, body) {
      const res = await call(`https://api.github.com/${path}`, { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`POST ${path}: HTTP ${res.status} ${await res.text()}`);
      return res.json();
    },
  };
}

export async function gather(api, repo, n) {
  const pr = await api.get(`repos/${repo}/pulls/${n}`);
  const [issueComments, reviews, inline, statuses] = await Promise.all([
    api.get(`repos/${repo}/issues/${n}/comments`),
    api.get(`repos/${repo}/pulls/${n}/reviews`),
    api.get(`repos/${repo}/pulls/${n}/comments`),
    api.get(`repos/${repo}/commits/${pr.head.sha}/statuses`),
  ]);
  return { pr, issueComments, reviews, inline, statuses };
}

const describe = (status) => (status ? `${status.state}|${status.description}` : "");

// The workflow's run: post the status when it changed, and the tag for Glen once. The retry is the
// watcher's (it posts as a person), unless a comment token was given to the workflow.
export async function applyEvent({ api, commentApi = null, repo, n, log = console.log, pause = 15000 }) {
  let data = await gather(api, repo, n);
  if (data.pr.state !== "open") return;
  let v = evaluate(data);
  // Codex's findings post seconds after its summary says completed, with no event of their own:
  // look again for up to a minute rather than leave the status pending (apto-hub #328).
  for (let i = 0; i < 4 && v.settling; i++) {
    await new Promise((r) => setTimeout(r, pause));
    data = await gather(api, repo, n);
    v = evaluate(data);
  }
  const head = data.pr.head.sha;
  const latest = data.statuses.find((s) => s.context === CONTEXT); // newest first
  if (describe(latest) !== `${v.result}|${v.description.slice(0, 140)}`) {
    await api.post(`repos/${repo}/statuses/${head}`, {
      state: v.result, context: CONTEXT, description: v.description.slice(0, 140), target_url: data.pr.html_url,
    });
  }
  if (v.action === "attention") await api.post(`repos/${repo}/issues/${n}/comments`, { body: commentFor("attention", head) });
  if (v.action === "retry" && commentApi) await commentApi.post(`repos/${repo}/issues/${n}/comments`, { body: commentFor("retry", head) });
  log(`#${n} ${short(head)} ${v.result}${v.action ? " +" + v.action : ""}`);
}

// The watcher's pass over one repo: retry as a person, and wake the workflow when the verdict moved.
export async function applySweep({ api, repo, log = console.log }) {
  const open = await api.get(`repos/${repo}/pulls?state=open`);
  for (const p of open) {
    if (p.draft) continue;
    const data = await gather(api, repo, p.number);
    const v = evaluate(data);
    const head = data.pr.head.sha;
    if (v.action === "retry") await api.post(`repos/${repo}/issues/${p.number}/comments`, { body: commentFor("retry", head) });
    const latest = data.statuses.find((s) => s.context === CONTEXT);
    if (v.action === "attention" || describe(latest) !== `${v.result}|${v.description.slice(0, 140)}`) {
      await api.post(`repos/${repo}/actions/workflows/codex-review.yml/dispatches`, { ref: data.pr.base.repo.default_branch, inputs: { pr: String(p.number) } });
    }
    log(`${repo}#${p.number} ${short(head)} ${v.result}${v.action ? " +" + v.action : ""}`);
  }
}

async function main() {
  const fs = await import("node:fs");
  const api = client(process.env.GITHUB_TOKEN);
  const sweep = process.argv.indexOf("--sweep");
  if (sweep >= 0) {
    let failed = 0;
    for (const repo of process.argv.slice(sweep + 1)) {
      try {
        await applySweep({ api, repo });
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
  await applyEvent({ api, commentApi, repo, n });
}

if (process.argv.includes("--event") || process.argv.includes("--sweep")) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
