import test from 'node:test';
import assert from 'node:assert/strict';
import { ThermalGuard } from '../electron/thermal.mjs';

test('thermal pressure cancels work once and blocks new loads until cleanup and cooling finish', async () => {
  let stops = 0, finish;
  const guard = new ThermalGuard({ onStop: async () => { stops++; await new Promise(r => { finish = r; }); } });
  await guard.update('nominal'); guard.assertReady();
  const stopping = guard.update('serious');
  guard.update('critical'); guard.update('serious');
  await Promise.resolve();
  assert.equal(stops, 1);
  assert.throws(() => guard.assertReady(), /cool down/);
  guard.update('unknown');
  assert.throws(() => guard.assertReady(), /cool down/);
  guard.update('nominal');
  assert.throws(() => guard.assertReady(), /cool down/);
  finish(); await stopping;
  guard.assertReady();
  await guard.update('fair'); guard.assertReady();
});

test('thermal state is observable and a later overheating episode stops again', async () => {
  const states = []; let stops = 0;
  const guard = new ThermalGuard({ onStop: async () => { stops++; }, onChange: state => states.push(state) });
  await guard.update('critical');
  await guard.update('critical');
  assert.equal(stops, 1);
  await guard.update('fair');
  await guard.update('serious');
  assert.equal(stops, 2);
  assert.deepEqual(states.at(-1), { thermalState: 'serious', thermalBlocked: true });
});
