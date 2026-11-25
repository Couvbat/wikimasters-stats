// Tests : données rangées carte par carte dans IndexedDB (1.32.0). Chaque carte de prices, obsSales et hist a sa propre entrée
// (wmstats.v1.p.<carte>, .o., .h.) : un enregistrement n'écrit que les cartes qui ont changé.
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');

const KEY = 'wmstats.v1';
const T = '2026-11-20T10:00:00.000Z', T2 = '2026-11-21T10:00:00.000Z';
const shared = idbData => JSON.parse(idbData.get(KEY) || '{}');
const entry = (idbData, k) => (idbData.has(k) ? JSON.parse(idbData.get(k)) : undefined);
// Trois cartes, une par section.
const fill = db => {
  db.prices.C1 = { at: 1, sales: [{ p: 5, t: T, r: 'R' }] };
  db.obsSales.C2 = [{ p: 7, t: T, g: 0 }];
  db.hist.C3 = { at: 2, w: { R: [['2026-11-16', 10, 5, 20, 3]] } };
};
async function idbLoad(data) {
  const env = load({ idb: { data: data || new Map() } });
  await env.ready;
  return env;
}

// ----- Tâche 1 : entrées par carte -----
test('chaque carte a son entrée ; wmstats.v1 n’a plus les ventes', async () => {
  const { t, idbData } = await idbLoad();
  fill(t.db);
  t.saveDb();
  await t.store.idle();
  assert.deepEqual(entry(idbData, KEY + '.p.C1'), plain(t.db.prices.C1));
  assert.deepEqual(entry(idbData, KEY + '.o.C2'), plain(t.db.obsSales.C2));
  assert.deepEqual(entry(idbData, KEY + '.h.C3'), plain(t.db.hist.C3));
  const s = shared(idbData);
  assert.deepEqual([s.prices, s.obsSales, s.hist], [{}, {}, {}]);
});

test('une seule carte changée : seule son entrée est écrite', async () => {
  const { t, idbStats } = await idbLoad();
  fill(t.db);
  t.saveDb();
  await t.store.idle();
  const n0 = idbStats.puts.length;
  t.db.obsSales.C2 = t.db.obsSales.C2.concat([{ p: 8, t: T2, g: 0 }]);
  t.saveDb();
  await t.store.idle();
  assert.deepEqual(idbStats.puts.slice(n0), [KEY + '.o.C2']);
});

test('une carte retirée : son entrée est effacée', async () => {
  const { t, idbData } = await idbLoad();
  fill(t.db);
  t.saveDb();
  await t.store.idle();
  delete t.db.obsSales.C2;
  t.saveDb();
  await t.store.idle();
  assert.equal(idbData.has(KEY + '.o.C2'), false);
  assert.ok(idbData.has(KEY + '.p.C1'), 'les autres restent');
});

test('rechargement : les mêmes cartes, une entrée abîmée ignorée, un identifiant à point relu entier', async () => {
  const data = new Map();
  const a = await idbLoad(data);
  fill(a.t.db);
  a.t.db.obsSales['A.B'] = [{ p: 3, t: T, g: 0 }];
  a.t.saveDb();
  await a.t.store.idle();
  data.set(KEY + '.o.X', '{abîmé');
  const b = await idbLoad(data);
  assert.deepEqual(plain(b.t.db.prices.C1), plain(a.t.db.prices.C1));
  assert.deepEqual(plain(b.t.db.obsSales['A.B']), [{ p: 3, t: T, g: 0 }]);
  assert.deepEqual(plain(b.t.db.hist.C3), plain(a.t.db.hist.C3));
  assert.equal(b.t.db.obsSales.X, undefined, 'entrée abîmée ignorée');
});

test('des entrées par carte sans wmstats.v1 : les cartes sont gardées', async () => {
  const data = new Map([['wmstats.meta', '{"since":1}'], [KEY + '.o.C9', JSON.stringify([{ p: 1, t: T, g: 0 }])]]);
  data.hasKv = true;
  const { t } = await idbLoad(data);
  assert.deepEqual(plain(t.db.obsSales.C9), [{ p: 1, t: T, g: 0 }]);
});

test('mode localStorage : une seule clé, comme avant', () => {
  const env = load();
  fill(env.t.db);
  env.t.saveDb();
  assert.ok(JSON.parse(env.store.get(KEY)).prices.C1, 'les ventes restent dans wmstats.v1');
  assert.deepEqual([...env.store.keys()].filter(k => /\.(p|o|h)\./.test(k)), []);
});

// ----- Tâche 2 : passage au nouveau rangement et fusion -----
const W_OLD = { R: [['2026-11-09', 9, 5, 20, 3]] }, W_NEW = { R: [['2026-11-16', 10, 5, 20, 3]] };
const base = (sections, more = {}) => {
  const data = new Map([['wmstats.meta', '{"since":1}'], [KEY, JSON.stringify(Object.assign({ userId: '', prices: {}, obsSales: {}, hist: {} }, sections))]]);
  for (const [k, v] of Object.entries(more)) data.set(k, JSON.stringify(v));
  data.hasKv = true;
  return data;
};

test('une base d’avant la 1.32 passe aux entrées par carte', async () => {
  const data = base({ prices: { C1: { at: 1, sales: [{ p: 5, t: T, r: 'R' }] } }, obsSales: { C2: [{ p: 7, t: T, g: 0 }] }, hist: { C3: { at: 2, w: W_OLD } } });
  const { t, idbData } = await idbLoad(data);
  assert.ok(t.db.prices.C1 && t.db.obsSales.C2 && t.db.hist.C3, 'les cartes sont chargées');
  t.saveDb();
  await t.store.idle();
  assert.deepEqual(entry(idbData, KEY + '.o.C2'), [{ p: 7, t: T, g: 0 }]);
  assert.ok(entry(idbData, KEY + '.p.C1') && entry(idbData, KEY + '.h.C3'));
  const s = shared(idbData);
  assert.deepEqual([s.prices, s.obsSales, s.hist], [{}, {}, {}]);
});

test('un onglet d’avant la 1.32 a réécrit wmstats.v1 : fusion sans perte', async () => {
  const data = base(
    { prices: { C1: { at: 5, sales: [{ p: 6, t: T, r: 'R' }] } }, obsSales: { C2: [{ p: 8, t: T2, g: 0 }, { p: 7, t: T, g: 0 }] }, hist: { C3: { at: 9, w: W_NEW } } },
    { [KEY + '.p.C1']: { at: 10, sales: [{ p: 5, t: T2, r: 'R' }] }, [KEY + '.o.C2']: [{ p: 7, t: T, g: 0 }], [KEY + '.h.C3']: { at: 2, w: W_OLD } });
  const { t, idbData } = await idbLoad(data);
  assert.deepEqual(plain(t.db.obsSales.C2), [{ p: 8, t: T2, g: 0 }, { p: 7, t: T, g: 0 }], 'ventes observées réunies');
  assert.equal(t.db.prices.C1.at, 10, 'le relevé le plus récent');
  assert.deepEqual(plain(t.db.prices.C1.sales), [{ p: 5, t: T2, r: 'R' }, { p: 6, t: T, r: 'R' }], 'ventes réunies');
  assert.deepEqual(plain(t.db.hist.C3), { at: 9, w: W_NEW }, 'l’historique le plus récent');
  t.saveDb();
  await t.store.idle();
  assert.equal(entry(idbData, KEY + '.o.C2').length, 2, 'la fusion est écrite');
  assert.deepEqual(shared(idbData).obsSales, {});
});
