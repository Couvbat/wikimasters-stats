// Tests : enregistrer quand le navigateur est presque plein, y compris depuis l'ancien format (tout sous wmstats.v1, avant la 1.20).
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const KEY = 'wmstats.v1';
const POOL = 'http://127.0.0.1:8787';
const T = i => new Date(Date.parse('2026-11-15T00:00:00Z') - i * 36e5).toISOString();

// Un navigateur au quota réaliste : la somme des clés et des textes enregistrés ne dépasse pas « limit » caractères.
const quota = limit => (v, k, store) => {
  let used = 0;
  for (const [key, val] of store) if (key !== k) used += key.length + val.length;
  return used + k.length + v.length > limit;
};
// Le format d'avant la 1.20 : la collection, les souhaits… et les prix, tout dans wmstats.v1.
function legacy() {
  const cards = {}, prices = {};
  for (let i = 0; i < 1500; i++) cards['x' + i] = { cardId: 'C' + i, title: 'Carte numéro ' + i, rarity: 'R', count: 1 };
  for (let i = 0; i < 300; i++) prices['C' + i] = { at: 1, sales: Array.from({ length: 10 }, (_, j) => ({ p: 100 + j, t: T(j), r: 'R' })) };
  return JSON.stringify({ userId: 'U1', me: 'Jules', cards, prices, wish: { W1: ['Coluche', 'L'] } });
}

test('ancien format dans un navigateur presque plein : le premier enregistrement réussit et range les données par compte', () => {
  const old = legacy();
  const { t, store } = load({ storage: { [KEY]: old }, reject: quota(KEY.length + old.length + 2000) });
  assert.equal(Object.keys(t.db.cards).length, 1500, 'l’ancien format se lit');
  t.db.pool.url = POOL;
  assert.equal(t.saveDb(), true, 'l’enregistrement doit réussir');
  assert.ok(store.has(KEY + '.u.U1'), 'la partie personnelle a sa clé');
  assert.ok(!JSON.parse(store.get(KEY)).cards, 'elle n’est plus dans la partie commune');
  t.db = t.loadDb();
  assert.equal(t.db.pool.url, POOL, 'l’adresse du pool est gardée au rechargement');
  assert.equal(Object.keys(t.db.cards).length, 1500, 'la collection aussi');
  assert.equal(Object.keys(t.db.prices).length, 300, 'et les prix');
});

test('partie personnelle qui ne tient vraiment pas : ce qui était enregistré reste tel quel', () => {
  const old = legacy();
  const { t, store } = load({ storage: { [KEY]: old }, reject: (v, k) => k.startsWith(KEY + '.u.') });
  t.db.pool.url = POOL;
  assert.equal(t.saveDb(), false);
  assert.equal(store.get(KEY), old, 'l’ancien enregistrement n’a pas été remplacé par une partie commune sans la collection');
  assert.ok(!store.has(KEY + '.u.U1'));
});

test('rien ne s’enregistre : l’en-tête le dit, et l’avertissement part dès que ça repasse', () => {
  let full = true;
  const { t } = load({ reject: () => full });
  assert.equal(t.saveDb(), false);
  assert.match(t.saveWarning(), /Navigateur plein/);
  full = false;
  assert.equal(t.saveDb(), true);
  assert.equal(t.saveWarning(), '');
});
