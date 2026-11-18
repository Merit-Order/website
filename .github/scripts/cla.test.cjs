// Tests for cla.cjs against an in-memory fake of the GitHub API. Run with: node --test .github/scripts/cla.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const {run, sign, missingSigners, commentBody, PHRASE, MARKER} = require('./cla.cjs');

const repo = {owner: 'Merit-Order', repo: 'meritorder'};
const alice = {login: 'alice', id: 11};
const bob = {login: 'bob', id: 12};
const therick = {login: 'therick', id: 319326};

/** A fake of the parts of Octokit the script uses, with the signatures file, commits, comments and statuses. */
function fakeGitHub({commits, signed = [], conflicts = 0}) {
  const state = {signed, sha: 'sha0', conflicts, comments: [], statuses: [], writes: 0};
  const encode = (v) => Buffer.from(JSON.stringify({signedContributors: v})).toString('base64');
  const github = {
    paginate: async (fn, params) => (await fn(params)).data,
    rest: {
      repos: {
        getContent: async () => ({data: {content: encode(state.signed), sha: state.sha}}),
        createOrUpdateFileContents: async ({sha, content}) => {
          if (sha !== state.sha || state.conflicts-- > 0) {
            state.sha += "'"; // someone else wrote first
            throw Object.assign(new Error('conflict'), {status: 409});
          }
          state.signed = JSON.parse(Buffer.from(content, 'base64').toString()).signedContributors;
          state.sha = `sha${++state.writes}`;
        },
        createCommitStatus: async (s) => state.statuses.push(s),
      },
      pulls: {
        listCommits: async () => ({data: commits.map((a) => (a.login ? {author: a} : {author: null, commit: {author: a}}))}),
        get: async () => ({data: pr}),
      },
      issues: {
        listComments: async () => ({data: state.comments}),
        createComment: async ({body}) => state.comments.push({id: state.comments.length + 1, body, user: {login: 'github-actions[bot]'}}),
        updateComment: async ({comment_id, body}) => { state.comments.find((c) => c.id === comment_id).body = body; },
      },
    },
  };
  return {github, state};
}

const pr = {number: 7, user: alice, head: {sha: 'head1'}};
const prEvent = {eventName: 'pull_request_target', repo, payload: {pull_request: pr, repository: {id: 1, default_branch: 'main'}}};
const commentEvent = (user, body) => ({
  eventName: 'issue_comment', repo,
  payload: {issue: {number: 7, pull_request: {}}, comment: {id: 99, body, user, created_at: 'now'}, repository: {id: 1, default_branch: 'main'}},
});

test('the allowlist and signed contributors need nothing more', () => {
  assert.deepEqual(missingSigners([therick, alice, bob], [{id: 11}]), [bob]);
});

test('an unsigned author fails the check and gets one comment, edited on later pushes', async () => {
  const {github, state} = fakeGitHub({commits: [alice, bob]});
  assert.equal(await run({github, context: prEvent}), false);
  assert.equal(await run({github, context: prEvent}), false);
  assert.equal(state.comments.length, 1);
  assert.match(state.comments[0].body, /@alice, @bob/);
  assert.ok(state.comments[0].body.includes(PHRASE));
  assert.deepEqual(state.statuses.map((s) => [s.context, s.state, s.sha]), [['CLA', 'failure', 'head1'], ['CLA', 'failure', 'head1']]);
});

test('the maintainer and bots pass without a comment', async () => {
  const {github, state} = fakeGitHub({commits: [therick, {login: 'dependabot[bot]', id: 5}]});
  assert.equal(await run({github, context: {...prEvent, payload: {...prEvent.payload, pull_request: {...pr, user: therick}}}}), true);
  assert.equal(state.comments.length, 0);
  assert.equal(state.statuses[0].state, 'success');
});

test('commits not linked to an account fail the check and say how to fix it', async () => {
  const {github, state} = fakeGitHub({commits: [{name: 'Someone', email: 's@example.com'}], signed: [{id: 11}]});
  assert.equal(await run({github, context: prEvent}), false);
  assert.match(state.comments[0].body, /Someone/);
});

test('signing records the signature, passes once everyone has, and edits the comment', async () => {
  const {github, state} = fakeGitHub({commits: [alice, bob]});
  await run({github, context: prEvent});
  assert.equal(await run({github, context: commentEvent(alice, `  ${PHRASE}\n`)}), false);
  assert.deepEqual(state.signed.map((s) => [s.name, s.id, s.comment_id, s.pullRequestNo, s.repoId]), [['alice', 11, 99, 7, 1]]);
  assert.equal(await run({github, context: commentEvent(bob, PHRASE)}), true);
  assert.equal(state.statuses.at(-1).state, 'success');
  assert.equal(state.comments.length, 1);
  assert.ok(state.comments[0].body.startsWith(`${MARKER}\nEveryone`));
});

test('other comments, outsiders and repeat signatures change nothing', async () => {
  const {github, state} = fakeGitHub({commits: [alice], signed: [{id: 11, name: 'alice'}]});
  assert.equal(await run({github, context: commentEvent(alice, `${PHRASE}, maybe`)}), null);
  await run({github, context: commentEvent(alice, PHRASE)});
  await run({github, context: commentEvent({login: 'mallory', id: 66}, PHRASE)});
  assert.equal(state.writes, 0);
  const notPr = commentEvent(alice, PHRASE);
  delete notPr.payload.issue.pull_request;
  assert.equal(await run({github, context: notPr}), null);
});

test('a concurrent write is retried on the new sha, and gives up after five tries', async () => {
  const sig = {name: 'alice', id: 11, pullRequestNo: 7};
  const ok = fakeGitHub({commits: [], signed: [{id: 12}], conflicts: 2});
  await sign(ok.github, repo, sig);
  assert.deepEqual(ok.state.signed.map((s) => s.id), [12, 11]);
  const busy = fakeGitHub({commits: [], conflicts: 9});
  await assert.rejects(sign(busy.github, repo, sig), {status: 409});
});

test('the comment for everyone signed has no sign instructions', () => {
  assert.ok(!commentBody([], [], 'u').includes(PHRASE));
});
