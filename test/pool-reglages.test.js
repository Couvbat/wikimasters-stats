// Tests : activer le pool sur un navigateur déjà bien rempli (gros historique Pro).
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const KEY = 'wmstats.v1';
const POOL = 'http://127.0.0.1:8787';
const GROUP = 'cle-du-groupe-assez-longue-123';
const T = i => new Date(Date.parse('2026-11-15T00:00:00Z') - i * 36e5).toISOString();
const sales = n => Array.from({ length: n }, (_, i) => ({ p: 100 + i, t: T(i), r: 'L' }));

test('activer le pool sur un gros historique Pro : adresse, clé et case restent enregistrées', () => {
  let limit = Infinity;
  const { t, store } = load({ reject: s => s.length > limit });
  t.db.prices = {};
  for (let c = 0; c < 300; c++) t.db.prices['C' + c] = { at: 1, sales: sales(20) };
  assert.equal(t.saveDb(), true);
  limit = store.get(KEY).length + 20000; // le navigateur a encore un peu de place, pas de quoi doubler l'historique
  // Comme dans les Réglages : l'adresse, la clé, puis la case « Partager et recevoir les prix ».
  t.db.pool.url = POOL; t.saveDb();
  t.db.pool.key = GROUP; t.saveDb();
  t.db.pool.on = true; t.poolBackfill();
  assert.equal(t.saveDb(), true, 'l’enregistrement doit réussir');
  const saved = JSON.parse(store.get(KEY));
  assert.equal(saved.pool.url, POOL);
  assert.equal(saved.pool.key, GROUP);
  assert.equal(saved.pool.on, true);
  assert.equal(saved.poolQ.length, 300, 'tes relevés Pro attendent d’être envoyés');
  assert.equal(saved.prices.C0.sales.length, 20, 'l’historique des prix n’a pas été raccourci pour faire de la place');
});
