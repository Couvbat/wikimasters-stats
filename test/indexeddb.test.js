// Tests : données rangées dans IndexedDB (sans la limite de 5 Mo du localStorage), migration vérifiée, mode secours.
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const KEY = 'wmstats.v1';

// ----- Tâche 1 : couche store en mode local -----
test('mode local sans indexedDB : store.get lit le localStorage et storeLine le dit', () => {
  const { t } = load({ storage: { [KEY]: '{"prices":{}}' } });
  assert.equal(t.store.mode, 'local');
  assert.equal(t.store.loaded, true);
  assert.equal(t.store.get(KEY), '{"prices":{}}');
  assert.match(t.storeLine(), /^Rangées dans le stockage du site \(limité à 5 Mo\) : 0,0 Mo\.$/);
});

test('mode local : la ligne des comptes compte les clés wmstats.v1.u.*, sans _', () => {
  const { t } = load({ storage: { [KEY]: '{"prices":{}}', [KEY + '.u.U1']: '{}', [KEY + '.u.U2']: '{}', [KEY + '.u._']: '{}', 'wmstats.auto': '{}' } });
  assert.equal(t.store.keys().filter(k => k.startsWith(KEY + '.u.') && k !== KEY + '.u._').length, 2);
  assert.ok(!t.store.keys().includes('wmstats.auto'), 'seules les clés de la base');
});

// ----- Tâche 2 : ouverture de la base, chargement et migration -----
const sharedText = url => JSON.stringify({ userId: 'U1', prices: { C1: { at: 1, sales: [] } }, pool: { url } });
const mineText = (id, card) => JSON.stringify({ cards: { [id]: { cardId: card, title: card, rarity: 'R', count: 1 } } });

test('migration de deux comptes : copie identique, ancien stockage effacé sauf wmstats.auto', async () => {
  const shared = sharedText('http://127.0.0.1:8787'), u1 = mineText('x1', 'A'), u2 = mineText('x2', 'B');
  const env = load({ idb: {}, storage: { [KEY]: shared, [KEY + '.u.U1']: u1, [KEY + '.u.U2']: u2, 'wmstats.auto': '{"at":1}' } });
  assert.equal(env.t.store.loaded, false, 'pas encore chargé');
  await env.ready;
  const { t, idbData } = env;
  assert.equal(t.store.mode, 'idb');
  assert.equal(t.store.loaded, true);
  assert.equal(idbData.get(KEY), shared);
  assert.equal(idbData.get(KEY + '.u.U1'), u1);
  assert.equal(idbData.get(KEY + '.u.U2'), u2);
  assert.deepEqual([...env.store.keys()], ['wmstats.auto'], 'il ne reste que le verrou de la collecte automatique');
  assert.deepEqual(Object.keys(t.db.cards), ['x1']);
  assert.equal(t.db.pool.url, 'http://127.0.0.1:8787');
});

test('migration de l’ancien format d’avant la 1.20 : copié tel quel, collection lue', async () => {
  const legacy = JSON.stringify({ userId: 'U1', prices: {}, cards: { x1: { cardId: 'A', title: 'A', rarity: 'R', count: 1 } } });
  const env = load({ idb: {}, storage: { [KEY]: legacy } });
  await env.ready;
  assert.equal(env.idbData.get(KEY), legacy);
  assert.deepEqual(Object.keys(env.t.db.cards), ['x1']);
});

test('relecture différente : rien n’est effacé, mode local', async () => {
  const shared = sharedText('L'), u1 = mineText('x1', 'A');
  const env = load({ idb: { corruptReads: true }, storage: { [KEY]: shared, [KEY + '.u.U1']: u1 } });
  await env.ready;
  assert.equal(env.t.store.mode, 'local');
  assert.equal(env.store.get(KEY), shared);
  assert.equal(env.store.get(KEY + '.u.U1'), u1);
  assert.equal(env.t.db.pool.url, 'L');
  assert.deepEqual(Object.keys(env.t.db.cards), ['x1']);
});

test('base déjà remplie : elle fait foi, les clés restantes du localStorage sont effacées', async () => {
  const data = new Map([[KEY, sharedText('A')]]);
  const env = load({ idb: { data }, storage: { [KEY]: sharedText('B'), 'wmstats.auto': '{"at":1}' } });
  await env.ready;
  assert.equal(env.t.db.pool.url, 'A');
  assert.equal(env.store.has(KEY), false);
  assert.equal(env.store.has('wmstats.auto'), true);
});

test('open qui lève une exception : mode local, rien ne plante', async () => {
  const env = load({ idb: { openThrows: true }, storage: { [KEY]: sharedText('L') } });
  await env.ready;
  assert.equal(env.t.store.mode, 'local');
  assert.equal(env.t.db.pool.url, 'L');
  assert.equal(env.store.has(KEY), true, 'rien n’est effacé');
});

test('rien nulle part : défauts, mode idb', async () => {
  const env = load({ idb: {} });
  await env.ready;
  assert.equal(env.t.store.mode, 'idb');
  assert.equal(env.t.store.loaded, true);
  assert.deepEqual(Object.keys(env.t.db.prices), []);
  assert.equal(env.idbData.size, 0);
});
