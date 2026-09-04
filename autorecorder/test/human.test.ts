import assert from 'node:assert/strict';
import { test } from 'node:test';
import { between, chance, jitter, keystrokeDelay, rand, seedTake } from '../core/overlays/human';

test('the same seed gives the same sequence; different seeds differ', () => {
  seedTake('quickstart');
  const a = [rand(), rand(), rand()];
  seedTake('quickstart');
  const b = [rand(), rand(), rand()];
  seedTake('slots');
  const c = [rand(), rand(), rand()];
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('jitter stays within its spread and never collapses to zero', () => {
  seedTake('t');
  for (let i = 0; i < 500; i++) {
    const v = jitter(1000, 0.25);
    assert.ok(v >= 750 && v <= 1250, String(v));
  }
  assert.ok(jitter(100, 5) >= 25);
});

test('between and chance respect their bounds', () => {
  seedTake('t');
  for (let i = 0; i < 500; i++) {
    const v = between(3, 7);
    assert.ok(v >= 3 && v < 7);
  }
  assert.equal(chance(0), false);
  assert.equal(chance(1), true);
});

test('keystroke delays are longer after punctuation and line breaks', () => {
  const avg = (ch: string): number => {
    seedTake('k');
    let sum = 0;
    for (let i = 0; i < 300; i++) sum += keystrokeDelay(ch, { thinkChance: 0 });
    return sum / 300;
  };
  assert.ok(avg('.') > avg('a') + 100);
  assert.ok(avg('\n') > avg('.'));
  assert.ok(avg('a') >= 18);
});
