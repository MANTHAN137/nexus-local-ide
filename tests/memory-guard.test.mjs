import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryPressureGuard } from '../electron/memory-guard.mjs';

const GiB = 1024 ** 3;
function fixture(options = {}) {
  let elapsed = 0;
  const wallStart = 1700000000000;
  const guard = new MemoryPressureGuard({ now: () => elapsed, wallNow: () => wallStart + elapsed, ...options });
  return {
    guard,
    sample(at, changes = {}) {
      elapsed = at;
      return guard.evaluate({ pressure: 'normal', availableMemory: 3 * GiB, sampledAt: wallStart + elapsed, ...changes });
    },
    missing(at) { elapsed = at; return guard.evaluate(null); },
    wallStart,
  };
}

test('temporary warning recovers after five stable normal seconds', () => {
  const f = fixture();
  assert.equal(f.sample(0).action, 'continue');
  assert.deepEqual(f.sample(1000, { pressure: 'warning' }), { action: 'warn', reason: 'macOS is under memory pressure; allowing compression to settle.', graceRemainingMs: 30000 });
  assert.equal(f.sample(5000).action, 'warn');
  assert.equal(f.sample(9999).action, 'warn');
  assert.equal(f.sample(10000).action, 'continue');
  assert.equal(f.sample(11000, { pressure: 'warning' }).graceRemainingMs, 30000);
});

test('persistent warning stops after one allowance and cannot resume itself', () => {
  const f = fixture();
  f.sample(0, { pressure: 'warning' });
  assert.equal(f.sample(29999, { pressure: 'warning' }).graceRemainingMs, 1);
  const stopped = f.sample(30000, { pressure: 'warning' });
  assert.equal(stopped.action, 'stop');
  assert.match(stopped.reason, /warning/);
  assert.deepEqual(f.sample(35000), stopped);
});

test('short normal interruptions do not restart the warning deadline', () => {
  const f = fixture();
  f.sample(0, { pressure: 'warning', phase: 'loading' });
  f.sample(28000, { phase: 'ready' });
  assert.equal(f.sample(29000, { pressure: 'warning', phase: 'generating' }).graceRemainingMs, 1000);
  assert.equal(f.sample(30000, { pressure: 'warning' }).action, 'stop');
});

test('stable normal recovery may finish past the warning deadline', () => {
  const f = fixture();
  f.sample(0, { pressure: 'warning' });
  assert.equal(f.sample(29000).action, 'warn');
  assert.equal(f.sample(32000).action, 'warn');
  assert.equal(f.sample(34000).action, 'continue');
});

test('critical pressure and the memory floor stop without a warning allowance', () => {
  assert.match(fixture().sample(0, { pressure: 'critical' }).reason, /critical/);
  assert.match(fixture().sample(0, { availableMemory: GiB - 1 }).reason, /safety floor/);
  assert.equal(fixture().sample(0, { availableMemory: GiB }).action, 'continue');
});

test('missing or unknown readings receive five seconds and recover with valid data', () => {
  const f = fixture();
  assert.equal(f.missing(0).graceRemainingMs, 5000);
  assert.equal(f.sample(4999, { pressure: 'unknown' }).graceRemainingMs, 1);
  assert.equal(f.sample(5000, { pressure: 'unknown' }).action, 'stop');
  const recovering = fixture();
  recovering.sample(0, { availableMemory: NaN });
  assert.equal(recovering.sample(3000).action, 'continue');
  assert.equal(recovering.missing(10000).graceRemainingMs, 5000);
});

test('stale readings stop without receiving a second allowance', () => {
  const f = fixture();
  assert.equal(f.sample(5000, { sampledAt: f.wallStart }).action, 'continue');
  assert.match(f.sample(5001, { sampledAt: f.wallStart }).reason, /stale/);
  assert.equal(fixture().sample(0, { sampledAt: undefined }).action, 'warn');
  assert.equal(fixture().sample(0, { sampledAt: Infinity }).action, 'warn');
  assert.equal(fixture().sample(0, { sampledAt: 1700000002000 }).action, 'warn');
});

test('unavailable data cannot clear or extend an existing warning episode', () => {
  const f = fixture();
  f.sample(0, { pressure: 'warning' });
  f.sample(27000);
  assert.equal(f.missing(29000).graceRemainingMs, 1000);
  assert.equal(f.sample(30000, { pressure: 'warning' }).action, 'stop');
});

test('valid swap growth over two GB stops; absent or invalid swap is ignored', () => {
  const f = fixture({ baselineSwap: 3 * GiB });
  assert.equal(f.sample(0, { swapUsedMemory: 5 * GiB }).action, 'continue');
  assert.match(f.sample(1000, { swapUsedMemory: 5 * GiB + 1 }).reason, /Swap/);
  for (const baselineSwap of [null, undefined, NaN, -1, Infinity]) {
    assert.equal(fixture({ baselineSwap }).sample(0, { swapUsedMemory: 8 * GiB }).action, 'continue');
  }
  for (const swapUsedMemory of [null, undefined, NaN, -1, Infinity]) {
    assert.equal(fixture({ baselineSwap: 0 }).sample(0, { swapUsedMemory }).action, 'continue');
  }
});
