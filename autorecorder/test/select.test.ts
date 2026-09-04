import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseShard, selectPages } from '../core/select';
import { type PageRecordConfig } from '../core/types';

const page = (id: string, name = id, extra: Partial<PageRecordConfig> = {}): PageRecordConfig =>
  ({
    id,
    name,
    videoName: id,
    docPath: id,
    route: id,
    ideFile: 'x',
    startLine: 1,
    endLine: 1,
    prompt: 'p',
    docUrl: '',
    demoUrl: '',
    filename: id,
    order: 0,
    ...extra,
  }) as PageRecordConfig;

const ALL = [
  page('quickstart', 'Quickstart'),
  page('slots', 'Custom Look and Feel - Slots'),
  page('headless-ui', 'Custom Look and Feel - Headless UI'),
  page('demo-npm', 'npm demo'),
];

test('no request records everything except the excluded set', () => {
  const { pages } = selectPages(ALL, { excluded: new Set(['demo-npm']) });
  assert.deepEqual(pages.map((p) => p.id), ['quickstart', 'slots', 'headless-ui']);
});

test('naming an excluded page explicitly still selects it', () => {
  const { pages } = selectPages(ALL, { page: 'demo-npm', excluded: new Set(['demo-npm']) });
  assert.deepEqual(pages.map((p) => p.id), ['demo-npm']);
});

test('ids win over everything else and are case-insensitive', () => {
  const { pages } = selectPages(ALL, { ids: ['SLOTS', 'quickstart'], page: 'headless-ui', filter: 'x' });
  assert.deepEqual(pages.map((p) => p.id), ['quickstart', 'slots']);
});

test('filter and bare words match id or name substrings', () => {
  assert.deepEqual(selectPages(ALL, { filter: 'look and feel' }).pages.map((p) => p.id), ['slots', 'headless-ui']);
  assert.deepEqual(selectPages(ALL, { queries: ['quick', 'npm'] }).pages.map((p) => p.id), ['quickstart', 'demo-npm']);
});

test('limit truncates before sharding', () => {
  const { pages, shard } = selectPages(ALL, { limit: 3, shard: { index: 2, total: 2 } });
  assert.deepEqual(pages.map((p) => p.id), ['headless-ui']);
  assert.deepEqual(shard, { index: 2, total: 2, from: 2, to: 3 });
});

test('a shard past the end is empty, not an error', () => {
  const { pages } = selectPages(ALL, { shard: { index: 4, total: 4 }, excluded: new Set(['demo-npm']) });
  assert.deepEqual(pages, []);
});

test('an out-of-range shard is ignored', () => {
  const { pages, shard } = selectPages(ALL, { shard: { index: 0, total: 2 } });
  assert.equal(pages.length, ALL.length);
  assert.equal(shard, undefined);
});

test('parseShard accepts K/N and rejects anything else', () => {
  assert.deepEqual(parseShard('2/3'), { index: 2, total: 3 });
  assert.deepEqual(parseShard(' 1 / 4 '.trim()), { index: 1, total: 4 });
  assert.equal(parseShard('two/three'), undefined);
  assert.equal(parseShard(''), undefined);
  assert.equal(parseShard(undefined), undefined);
});
