import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorktreeDeletion } from '../../server/worktree-delete.js';

const sha = 'a'.repeat(40);
const remote = 'b'.repeat(40);
const block = (path, branch = 'feature', flags = '') =>
  `worktree ${path}\0HEAD ${sha}\0${branch ? `branch refs/heads/${branch}` : 'detached'}\0${flags ? `${flags}\0` : ''}\0`;

function fixture() {
  const state = { list: block('/main', 'main') + block('/linked'), head: sha, status: ' M tracked\0?? new\0',
    diff: 'changes', cached: 'staged changes', untracked: 'new\0', ignored: 'cache\0',
    hashes: `${sha}\n${remote}\n`, remotes: `refs/remotes/other/topic ${remote}\n`, count: '2\n',
    flags: 'H tracked\0', sparse: 'false\n', staged: `100644 ${sha} 0\ttracked\0`, calls: [] };
  const git = async (args, cwd) => {
    state.calls.push({ args, cwd });
    if (args[0] === 'worktree' && args[1] === 'list') {
      if (state.removalFinished && state.afterRemoveListError) throw new Error(state.afterRemoveListError);
      return state.list;
    }
    if (args[0] === 'check-ref-format') return 'feature\n';
    if (args[0] === 'rev-parse') {
      if (state.pendingHead) await state.pendingHead;
      return `${state.head}\n`;
    }
    if (args[0] === 'status') return state.status;
    if (args[0] === 'diff') return args.includes('--cached') ? state.cached : state.diff;
    if (args[0] === 'ls-files') {
      if (args.includes('-v')) return state.flags;
      if (args.includes('--stage')) return state.staged;
      return args.includes('--ignored') ? state.ignored : state.untracked;
    }
    if (args[0] === 'config') return state.sparse;
    if (args[0] === 'hash-object') return state.hashes;
    if (args[0] === 'for-each-ref') return state.remotes;
    if (args[0] === 'rev-list') return state.count;
    if (args[0] === 'worktree' && args[1] === 'remove') {
      if (state.removeError) throw new Error(state.removeError);
      state.list = state.afterRemoveList ?? block('/main', 'main');
      state.removalFinished = true;
      if (state.afterRemoveHead) state.head = state.afterRemoveHead;
      return '';
    }
    if (args[0] === 'update-ref') {
      if (state.beforeRefDeleteHead) state.head = state.beforeRefDeleteHead;
      if (state.branchError) throw new Error(state.branchError);
      if (args.at(-1) !== state.head) throw new Error('branch changed since confirmation');
      state.branchRemoved = true;
      return '';
    }
    throw new Error(`Unexpected Git call: ${args}`);
  };
  return { state, deletion: createWorktreeDeletion('/main', git, { secret: Buffer.alloc(32) }) };
}

test('preview describes irreversible risks and confirmation removes the worktree AND local branch', async () => {
  const { state, deletion } = fixture();
  const preview = await deletion.preview('/linked');
  assert.equal(preview.path, '/linked');
  assert.equal(preview.branch, 'feature');
  assert.equal(preview.hasUncommittedWork, true);
  assert.equal(preview.ignoredFileCount, 1);
  assert.equal(preview.localOnlyCommitCount, 2);
  assert.equal(preview.remoteCheck, 'Locally known remote-tracking refs only; no fetch.');
  assert.equal(typeof preview.confirmation, 'string');
  assert.deepEqual(await deletion.remove('/linked', preview.confirmation),
    { removed: true, branchDeleted: true, branch: 'feature' });
  assert.deepEqual(state.calls.filter(({ args }) => args[1] === 'remove' || args[0] === 'update-ref'), [
    { args: ['worktree', 'remove', '--force', '--', '/linked'], cwd: '/main' },
    { args: ['update-ref', '--no-deref', '-d', 'refs/heads/feature', sha], cwd: '/main' },
  ]);
  assert.ok(state.calls.some(({ args }) => args.join(' ') === `rev-list --count ${sha} --not --remotes`));
});

test('hidden index flags and sparse checkout block confirmation even when status reports clean', async () => {
  for (const [flags, sparse, reason] of [
    ['h tracked\0', 'false\n', /assume-unchanged/i],
    ['s hidden\0', 'false\n', /assume-unchanged/i],
    ['S skipped\0', 'false\n', /skip-worktree/i],
    ['H tracked\0', 'true\n', /sparse.checkout/i],
  ]) {
    const { state, deletion } = fixture();
    const before = await deletion.preview('/linked');
    state.flags = flags;
    state.sparse = sparse;
    state.status = state.diff = state.cached = '';
    const preview = await deletion.preview('/linked');
    assert.match(preview.reason, reason);
    assert.equal(preview.confirmation, undefined);
    await assert.rejects(deletion.remove('/linked', before.confirmation), reason);
    assert.equal(state.calls.some(({ args }) => args[1] === 'remove' || args[0] === 'update-ref'), false);
  }
});

test('gitlinks block deletion even when a submodule is unpopulated and Git status is clean', async () => {
  const { state, deletion } = fixture();
  const before = await deletion.preview('/linked');
  state.staged += `160000 ${remote} 0\tvendor/unpopulated\0`;
  state.status = state.diff = state.cached = '';
  const preview = await deletion.preview('/linked');
  assert.match(preview.reason, /submodule.*cannot.*safely assess/i);
  assert.equal(preview.confirmation, undefined);
  await assert.rejects(deletion.remove('/linked', before.confirmation), /submodule/i);
  assert.equal(state.calls.some(({ args }) => args[1] === 'remove' || args[0] === 'update-ref'), false);
});

test('local branch deletion uses atomic expected-old-value removal and retains a tip changed at the deletion boundary', async () => {
  const successful = fixture();
  const preview = await successful.deletion.preview('/linked');
  await successful.deletion.remove('/linked', preview.confirmation);
  assert.equal(successful.state.branchRemoved, true);
  assert.deepEqual(successful.state.calls.filter(({ args }) => args[0] === 'update-ref'), [
    { args: ['update-ref', '--no-deref', '-d', 'refs/heads/feature', sha], cwd: '/main' },
  ]);
  assert.equal(successful.state.calls.some(({ args }) => args[0] === 'branch'), false);

  const changed = fixture();
  const before = await changed.deletion.preview('/linked');
  changed.state.beforeRefDeleteHead = remote;
  await assert.rejects(changed.deletion.remove('/linked', before.confirmation), (err) => {
    assert.equal(err.removed, true);
    assert.equal(err.branchDeleted, false);
    assert.match(err.message, /branch.*not deleted.*changed/);
    return true;
  });
  assert.equal(changed.state.head, remote);
  assert.equal(changed.state.branchRemoved, undefined);
});

test('branch deletion refreshes worktrees after removal and refuses checked-out or malformed fresh listings', async () => {
  for (const [listing, message] of [
    [block('/main', 'main') + block('/other', 'feature'), /another worktree/],
    [block('/main', 'main') + block('/linked', 'feature'), /another worktree/],
    ['worktree /main\0\0worktree\0branch refs/heads/feature\0\0', /malformed/],
    [block('/main', 'main') + block('/other').replace('refs/heads/feature', 'refs/remotes/feature'), /malformed/],
    [block('/main', 'main') + block('relative/path'), /malformed/],
  ]) {
    const { state, deletion } = fixture();
    const preview = await deletion.preview('/linked');
    state.afterRemoveList = listing;
    await assert.rejects(deletion.remove('/linked', preview.confirmation), (err) => {
      assert.equal(err.removed, true);
      assert.equal(err.branchDeleted, false);
      assert.match(err.message, message);
      return true;
    });
    assert.equal(state.calls.some(({ args }) => args[0] === 'update-ref'), false);
  }
  const { state, deletion } = fixture();
  const preview = await deletion.preview('/linked');
  state.afterRemoveListError = 'Cannot refresh worktrees';
  await assert.rejects(deletion.remove('/linked', preview.confirmation), /removed.*not deleted.*Cannot refresh/);
  assert.equal(state.calls.some(({ args }) => args[0] === 'update-ref'), false);
});

test('concurrent deletion is refused and a branch moved after worktree removal is not deleted', async () => {
  const { state, deletion } = fixture();
  const preview = await deletion.preview('/linked');
  let resume;
  state.pendingHead = new Promise((resolve) => { resume = resolve; });
  const first = deletion.remove('/linked', preview.confirmation);
  const second = deletion.remove('/linked', preview.confirmation);
  resume();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(state.calls.filter(({ args }) => args[1] === 'remove').length, 1);

  const moved = fixture();
  const before = await moved.deletion.preview('/linked');
  moved.state.afterRemoveHead = remote;
  await assert.rejects(moved.deletion.remove('/linked', before.confirmation), (err) => {
    assert.equal(err.removed, true);
    assert.match(err.message, /branch.*not deleted.*changed/);
    return true;
  });
  assert.equal(moved.state.branchRemoved, undefined);
});

test('assessment errors and malformed snapshots fail closed; detached clean worktrees need no branch deletion', async () => {
  for (const [key, value] of [
    ['count', 'error'], ['count', '-1'], ['count', '9007199254740992'], ['head', 'not a SHA'],
    ['flags', 'H tracked'], ['flags', 'malformed\0'], ['sparse', 'unknown'], ['staged', 'invalid\0'],
    ['hashes', ''], ['list', block('/main', 'main') + block('/linked', '').replace('detached', 'branch refs/heads/')],
  ]) {
    const { state, deletion } = fixture();
    state[key] = value;
    await assert.rejects(deletion.preview('/linked'));
    assert.equal(state.calls.some(({ args }) => args[1] === 'remove'), false);
  }
  const { state, deletion } = fixture();
  state.list = block('/main', 'main') + block('/linked', null);
  state.status = state.diff = state.cached = state.untracked = state.ignored = '';
  state.count = '0';
  const preview = await deletion.preview('/linked');
  assert.equal(preview.hasUncommittedWork, false);
  assert.equal(preview.ignoredFileCount, 0);
  assert.equal(preview.localOnlyCommitCount, 0);
  assert.deepEqual(await deletion.remove('/linked', preview.confirmation), { removed: true, branchDeleted: false, branch: null });
  assert.equal(state.calls.some(({ args }) => args[0] === 'update-ref'), false);
});

test('branch failure reports partial removal; worktree failure never deletes the branch', async () => {
  for (const failure of ['branchError', 'removeError']) {
    const { state, deletion } = fixture();
    const preview = await deletion.preview('/linked');
    state[failure] = 'Git refused';
    await assert.rejects(deletion.remove('/linked', preview.confirmation), (err) => {
      assert.equal(err.removed, failure === 'branchError' ? true : null);
      assert.match(err.message, failure === 'branchError' ? /removed.*branch.*not deleted/ : /may be partially removed.*branch.*not deleted/);
      return true;
    });
    if (failure === 'removeError') assert.equal(state.calls.some(({ args }) => args[0] === 'update-ref'), false);
  }
});

test('confirmation is bound to the clicked path and rejects changed safety snapshots', async () => {
  const { state, deletion } = fixture();
  state.list = block('/main', 'main') + block('/linked', null) + block('/other', null);
  const preview = await deletion.preview('/linked');
  await assert.rejects(deletion.remove('/other', preview.confirmation), /changed/);
  for (const [key, changed] of Object.entries({ status: 'A  staged\0', diff: 'new working bytes',
    cached: 'new staged bytes', untracked: 'another\0', ignored: 'more cache\0',
    hashes: `${remote}\n${sha}\n`, head: remote, remotes: `refs/remotes/other/topic ${sha}\n`, count: '3\n',
    flags: 'H tracked\0H another\0', staged: `100755 ${sha} 0\ttracked\0`,
    list: block('/main', 'main') + block('/linked', 'renamed') })) {
    const f = fixture();
    const before = await f.deletion.preview('/linked');
    f.state[key] = changed;
    await assert.rejects(f.deletion.remove('/linked', before.confirmation), /changed/);
    assert.equal(f.state.calls.some(({ args }) => args[1] === 'remove'), false, key);
  }
});

test('protected, unknown and invalid-branch worktrees cannot receive a deletion confirmation', async () => {
  for (const [list, running, target, reason] of [
    [block('/main', 'topic') + block('/linked'), '/linked', '/main', 'Main worktree'],
    [block('/main', 'main') + block('/linked'), '/linked', '/linked', 'running'],
    [block('/main', 'main') + block('/linked'), '/linked/subfolder', '/linked', 'running'],
    [block('/main', 'main') + block('/linked', 'main'), '/main', '/linked', 'Protected branch'],
    [block('/main', 'main') + block('/linked', 'feature', 'locked maintenance'), '/main', '/linked', 'Locked'],
    [block('/main', 'main') + block('/linked', null, 'bare'), '/main', '/linked', 'Bare'],
    [block('/main', 'main') + block('/linked') + block('/other'), '/main', '/linked', 'another worktree'],
    [block('/main', 'main') + block('/linked', '-danger'), '/main', '/linked', 'branch'],
    [block('/main', 'main') + block('/linked'), '/main', '/arbitrary', 'Unknown'],
  ]) {
    const { state } = fixture();
    state.list = list;
    // Every invocation uses a fake Git boundary, including safety failures.
    const git = async (args) => {
      state.calls.push({ args });
      if (args[0] === 'worktree' && args[1] === 'list') return list;
      throw new Error('Assessment should stop before operating on the protected path');
    };
    const deletion = createWorktreeDeletion(running, git, { secret: Buffer.alloc(32) });
    const preview = target === '/arbitrary' ? null : await deletion.preview(target);
    if (preview) {
      assert.match(preview.reason, new RegExp(reason));
      assert.equal(preview.confirmation, undefined);
    }
    await assert.rejects(deletion.remove(target, 'anything'), new RegExp(reason));
    assert.equal(state.calls.some(({ args }) => args[1] === 'remove' || args[0] === 'update-ref'), false);
  }
});
