// Tests de la réception par le fil du pool (1.28.0). Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, reply, plain } = require('./harness');
const T = '2026-11-15T10:00:00.000Z';

// ----- Tâche 3 : briques -----
test('plafond des ventes observées : 50 000 cartes en IndexedDB, 8 000 en mode secours', async () => {
  const idb = load({ idb: {} });
  await idb.ready;
  assert.equal(idb.t.obsCardsMax(), 50000);
  assert.equal(load().t.obsCardsMax(), 8000);
});

test('mode IndexedDB : plus de 8 000 cartes observées sont gardées', async () => {
  const { t, ready } = load({ idb: {} });
  await ready;
  const sales = Array.from({ length: 9000 }, (_, i) => ['K' + i, 10, T, 0, 1, '', null]);
  t.mergeObserved({ sales });
  assert.equal(Object.keys(t.db.obsSales).length, 9000);
});

test('un exact à la même date et au même prix rend exact le provisoire sans enchère', () => {
  const { t } = load();
  t.addObserved('C1', { p: 30, t: T, g: 5 }, null);
  assert.equal(t.addObserved('C1', { p: 30, t: T, g: 0, x: true, i: 'A1' }, null), true);
  assert.deepEqual(plain(t.db.obsSales.C1), [{ p: 30, t: T, g: 0, i: 'A1', x: 1 }]);
});

test('dropProvisional retire le provisoire et la file des prix finaux, jamais un exact', () => {
  const { t } = load();
  t.addObserved('C1', { p: 30, t: T, g: 5, i: 'A1' }, null);
  t.addObserved('C2', { p: 40, t: T, g: 0, i: 'A2', x: true }, null);
  t.db.finQ.A1 = ['C1', 'SR', Date.parse(T), 1];
  assert.equal(t.dropProvisional(['A1', 'A2', 'A3']), 1);
  assert.equal(t.db.obsSales.C1, undefined, 'carte vidée : retirée');
  assert.equal(t.db.obsSales.C2.length, 1);
  assert.equal(t.db.finQ.A1, undefined);
});

// ----- Tâche 4 : fusion d'une page -----
const page = (o = {}) => Object.assign({ pool: 'p1', max: 0, next: 0, more: false, sales: [], pro: [], unsold: [] }, o);

test('page : ventes Pro avec leur relevé, ventes observées, sorte inconnue ignorée', () => {
  const { t } = load();
  const n = t.applyFeedPage(page({
    sales: [[1, 'C1', 50, T, 'pro', '', 0, 'SR'], [2, 'C2', 30, T, 'prov', 'A1', 4, null], [3, 'C3', 9, T, 'futur', '', 0, null]],
    pro: [[4, 'C1', 1700000000000, 'Paul']]
  }));
  assert.ok(n >= 2);
  assert.deepEqual(plain(t.db.prices.C1), { at: 1700000000000, sales: [{ p: 50, t: T, r: 'SR' }], by: 'Paul' });
  assert.deepEqual(plain(t.db.obsSales.C2), [{ p: 30, t: T, g: 4, i: 'A1' }]);
  assert.equal(t.db.obsSales.C3, undefined);
  assert.equal(t.db.prices.C3, undefined);
});

test('page : vente Pro sans son relevé rangée à la date 1, puis la date arrive seule', () => {
  const { t } = load();
  t.applyFeedPage(page({ sales: [[1, 'C1', 50, T, 'pro', '', 0, null]] }));
  assert.equal(t.db.prices.C1.at, 1);
  t.applyFeedPage(page({ pro: [[2, 'C1', 1700000000000, 'Paul']] }));
  assert.equal(t.db.prices.C1.at, 1700000000000);
  assert.equal(t.db.prices.C1.by, 'Paul');
  assert.equal(t.db.prices.C1.sales.length, 1);
  t.applyFeedPage(page({ pro: [[3, 'C9', 1700000000000, 'Paul']] }));
  assert.equal(t.db.prices.C9, undefined, 'pas de relevé vide');
});

test('page : unsold et vente Pro d’une enchère retirent le provisoire', () => {
  const { t } = load();
  t.addObserved('C1', { p: 30, t: T, g: 5, i: 'A1' }, null);
  t.addObserved('C2', { p: 20, t: T, g: 5, i: 'A2' }, null);
  t.applyFeedPage(page({ unsold: [[1, 'A1']], sales: [[2, 'C2', 25, T, 'pro', 'A2', 0, null]] }));
  assert.equal(t.db.obsSales.C1, undefined);
  assert.equal(t.db.obsSales.C2, undefined);
  assert.equal(t.db.prices.C2.sales[0].p, 25);
});
