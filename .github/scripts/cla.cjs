// The CLA check, run by .github/workflows/cla.yml through actions/github-script.
//
// Who must sign: the pull request's author and every commit author. Signatures are kept as JSON on the
// cla-signatures branch, matched by GitHub user id (logins can change). The result is a commit status named "CLA"
// on the pull request's head commit, so the sign comment, which runs on another ref, can update the same check.
// It only reads the pull request through the API; it never checks out or runs its code.

const PHRASE = 'I have read the CLA Document and I hereby sign the CLA';
const ALLOWLIST = ['therick', 'dependabot[bot]', 'renovate[bot]', 'github-actions[bot]'];
const BRANCH = 'cla-signatures';
const FILE = 'signatures/version1/cla.json';
const CONTEXT = 'CLA';
const MARKER = '<!-- cla-check -->'; // marks the one comment this check posts and then edits

/** Reads the signatures file and its blob sha (needed to update it without overwriting someone else's write). */
async function readSignatures(github, repo) {
  const {data} = await github.rest.repos.getContent({...repo, path: FILE, ref: BRANCH});
  return {signed: JSON.parse(Buffer.from(data.content, 'base64').toString()).signedContributors, sha: data.sha};
}

/** The pull request's author and commit authors. A commit not linked to a GitHub account can't sign: "unlinked". */
async function requiredSigners(github, repo, pr) {
  const people = new Map([[pr.user.id, pr.user.login]]);
  const unlinked = new Set();
  const commits = await github.paginate(github.rest.pulls.listCommits, {...repo, pull_number: pr.number, per_page: 100});
  for (const c of commits) {
    if (c.author) people.set(c.author.id, c.author.login);
    else unlinked.add(c.commit.author.name || c.commit.author.email);
  }
  return {people: [...people].map(([id, login]) => ({id, login})), unlinked: [...unlinked]};
}

/** Pure: who still has to sign, given the signers and the stored signatures. */
function missingSigners(people, signed, allowlist = ALLOWLIST) {
  const ids = new Set(signed.map((s) => s.id));
  return people.filter((p) => !allowlist.includes(p.login) && !ids.has(p.id));
}

/** Pure: the text of the check's comment. */
function commentBody(missing, unlinked, claUrl) {
  if (!missing.length && !unlinked.length) return `${MARKER}\nEveryone on this pull request has signed the CLA. Thank you.`;
  const lines = [
    MARKER,
    'Thank you for the pull request. Before it can be merged, we ask that everyone who wrote it signs the ' +
      `[Contributor License Agreement](${claUrl}). You keep your copyright; the agreement grants Espeto LLC a license ` +
      'to your contribution.',
    '',
  ];
  if (missing.length) {
    lines.push(`Still to sign: ${missing.map((p) => `@${p.login}`).join(', ')}`, '');
    lines.push('To sign, post a comment on this pull request with exactly this text:', '', '```', PHRASE, '```', '');
  }
  if (unlinked.length) {
    lines.push(`Some commits aren't linked to a GitHub account (${unlinked.join(', ')}). ` +
      'Add the commit email address to your account, then comment `recheck`.', '');
  }
  lines.push('You only sign once. Comment `recheck` to run the check again.');
  return lines.join('\n');
}

/** Sets the CLA status on the head commit and posts or edits the one comment. Returns true when it passes. */
async function evaluate(github, repo, pr, claUrl) {
  const {people, unlinked} = await requiredSigners(github, repo, pr);
  const {signed} = await readSignatures(github, repo);
  const missing = missingSigners(people, signed);
  const ok = !missing.length && !unlinked.length;
  await github.rest.repos.createCommitStatus({
    ...repo, sha: pr.head.sha, context: CONTEXT, state: ok ? 'success' : 'failure', target_url: claUrl,
    description: ok ? 'Everyone has signed the CLA' : `Not signed yet: ${[...missing.map((p) => p.login), ...unlinked].join(', ')}`.slice(0, 140),
  });
  const comments = await github.paginate(github.rest.issues.listComments, {...repo, issue_number: pr.number, per_page: 100});
  const mine = comments.find((c) => c.user.login === 'github-actions[bot]' && c.body.startsWith(MARKER));
  const body = commentBody(missing, unlinked, claUrl);
  if (mine && mine.body !== body) await github.rest.issues.updateComment({...repo, comment_id: mine.id, body});
  else if (!mine && !ok) await github.rest.issues.createComment({...repo, issue_number: pr.number, body});
  return ok;
}

/** Appends a signature. Writing with the file's sha means a concurrent write fails with 409; then re-read and retry. */
async function sign(github, repo, signature, attempts = 5) {
  for (let i = 1; ; i++) {
    const {signed, sha} = await readSignatures(github, repo);
    if (signed.some((s) => s.id === signature.id)) return;
    const content = Buffer.from(JSON.stringify({signedContributors: [...signed, signature]}, null, 2) + '\n').toString('base64');
    try {
      await github.rest.repos.createOrUpdateFileContents({
        ...repo, path: FILE, branch: BRANCH, sha, content,
        message: `@${signature.name} has signed the CLA in ${repo.owner}/${repo.repo}#${signature.pullRequestNo}`,
      });
      return;
    } catch (e) {
      if (e.status !== 409 || i >= attempts) throw e;
    }
  }
}

/** Entry point for actions/github-script. */
async function run({github, context}) {
  const repo = context.repo;
  const claUrl = `https://github.com/${repo.owner}/${repo.repo}/blob/${context.payload.repository.default_branch}/CLA.md`;
  if (context.eventName === 'pull_request_target') return evaluate(github, repo, context.payload.pull_request, claUrl);

  // issue_comment: only the exact phrase or "recheck", only on pull requests.
  const {comment, issue} = context.payload;
  const text = comment.body.trim();
  if (!issue.pull_request || (text !== PHRASE && text !== 'recheck')) return null;
  const {data: pr} = await github.rest.pulls.get({...repo, pull_number: issue.number});
  if (text === PHRASE) {
    const {people} = await requiredSigners(github, repo, pr);
    const {signed} = await readSignatures(github, repo);
    if (missingSigners(people, signed).some((p) => p.id === comment.user.id)) {
      await sign(github, repo, {
        name: comment.user.login, id: comment.user.id, comment_id: comment.id, created_at: comment.created_at,
        repoId: context.payload.repository.id, pullRequestNo: pr.number,
      });
    }
  }
  return evaluate(github, repo, pr, claUrl);
}

module.exports = {run, sign, evaluate, missingSigners, commentBody, PHRASE, ALLOWLIST, MARKER};
