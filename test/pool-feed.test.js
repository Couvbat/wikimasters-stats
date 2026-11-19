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
