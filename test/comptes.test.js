// Tests : plusieurs comptes dans un même navigateur, et historique plus long pour les raretés de valeur.
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');

const BASE = Date.parse('2026-11-15T00:00:00Z');
const T = i => new Date(BASE - i * 36e5).toISOString();
const sales = (n, r, from = 0, price = 100) => Array.from({ length: n }, (_, i) => ({ p: price + i, t: T(from + i), r }));
const KEY = 'wmstats.v1';

// ----- Tâche 1 : historique par rareté et garde-fou -----
test('keepPerRarity : 20 ventes pour L, UR et SR, 10 pour les autres, 60 au plus', () => {
  const { t } = load();
  const a = t.keepPerRarity([...sales(25, 'L'), ...sales(15, 'R', 30)]);
  assert.equal(a.filter(s => s.r === 'L').length, 20);
  assert.equal(a.filter(s => s.r === 'R').length, 10);
  const b = t.keepPerRarity([...sales(30, 'L'), ...sales(30, 'UR', 30), ...sales(30, 'SR', 60), ...sales(5, 'R', 90)]);
  assert.equal(b.length, 60);
});

test('navigateur plein : l’historique est ramené à 10 ventes par rareté plutôt que de ne rien enregistrer', () => {
  // Le navigateur simulé refuse tout texte qui contient plus de 600 ventes.
  const { t, store } = load({ reject: s => (s.match(/"p":/g) || []).length > 600 });
  t.db.prices = {};
  for (let c = 0; c < 50; c++) t.db.prices['C' + c] = { at: 1, sales: sales(20, 'L') };
  assert.equal(t.saveDb(), true);
  assert.equal(t.db.prices.C0.sales.length, 10);
  assert.ok(store.get(KEY).includes('"C49"'));
});

// ----- Tâche 2 : données par compte -----
test('changer de compte : chacun garde ses données, les prix sont communs', () => {
  const { t } = load();
  t.ingestPro('U1', [{ is_pro: true }]);
  t.db.cards = { x1: { cardId: 'C1', title: 'A', rarity: 'L', count: 1 } };
  t.db.me = 'Jules';
  t.db.prices = { C1: { at: 1, sales: sales(3, 'L') } };
  t.saveDb();
  t.ingestPro('U2', [{ is_pro: false }]);
  assert.equal(t.db.userId, 'U2');
  assert.deepEqual(plain(t.db.cards), {});
  assert.equal(t.db.me, '');
  assert.equal(t.db.prices.C1.sales.length, 3, 'les prix restent');
  t.db.cards = { y1: { cardId: 'C9', title: 'B', rarity: 'C', count: 1 } };
  t.saveDb();
  t.ingestPro('U1', [{ is_pro: true }]);
  assert.deepEqual(Object.keys(t.db.cards), ['x1']);
  assert.equal(t.db.me, 'Jules');
  t.ingestPro('U2', [{ is_pro: false }]);
  assert.deepEqual(Object.keys(t.db.cards), ['y1']);
});

test('migration : l’ancienne clé unique est lue entière, puis répartie', () => {
  const old = { cards: { x1: { cardId: 'C1', title: 'A', rarity: 'L', count: 2 } }, prices: { C1: { at: 1, sales: [] } }, userId: 'U1', me: 'Jules', auctions: {}, trades: {} };
  const { t, store } = load({ storage: { [KEY]: JSON.stringify(old) } });
  assert.deepEqual(Object.keys(t.db.cards), ['x1']);
  assert.equal(t.db.me, 'Jules');
  t.saveDb();
  const shared = JSON.parse(store.get(KEY)), mine = JSON.parse(store.get(KEY + '.u.U1'));
  assert.equal(shared.cards, undefined);
  assert.ok(shared.prices.C1);
  assert.deepEqual(Object.keys(mine.cards), ['x1']);
  assert.equal(mine.me, 'Jules');
});

test('compte pas encore reconnu : ses données passent au premier compte détecté', () => {
  const { t, store } = load();
  t.db.cards = { x1: { cardId: 'C1', title: 'A', rarity: 'L', count: 1 } };
  t.saveDb();
  assert.ok(store.has(KEY + '.u._'));
  t.ingestPro('U3', [{ is_pro: false }]);
  assert.deepEqual(Object.keys(t.db.cards), ['x1']);
  assert.equal(store.has(KEY + '.u._'), false);
  assert.deepEqual(Object.keys(JSON.parse(store.get(KEY + '.u.U3')).cards), ['x1']);
});

test('collection d’un autre compte : la collection du compte précédent n’est pas effacée', () => {
  const { t, store } = load();
  t.ingestPro('U1', [{ is_pro: true }]);
  t.db.cards = { x1: { cardId: 'C1', title: 'A', rarity: 'L', count: 1 } };
  t.saveDb();
  t.ingestCollection([{ id: 'y1', user_id: 'U2', count: 1, card: { id: 'C9', wikipedia_title: 'B', rarity: 'C' } }], true);
  assert.equal(t.db.userId, 'U2');
  assert.deepEqual(Object.keys(t.db.cards), ['y1']);
  assert.deepEqual(Object.keys(JSON.parse(store.get(KEY + '.u.U1')).cards), ['x1']);
});

test('effacer les données de ce compte : la partie personnelle est vidée, les prix restent', () => {
  const { t } = load();
  t.ingestPro('U1', [{ is_pro: true }]);
  t.db.cards = { x1: { cardId: 'C1', title: 'A', rarity: 'L', count: 1 } };
  t.db.trades = { T1: { s: 'accepted', t: T(1), w: 'Paul', ini: 1, g: [], r: [], wg: 0, wr: 0 } };
  t.db.prices = { C1: { at: 1, sales: sales(3, 'L') } };
  t.clearAccount();
  assert.deepEqual(plain(t.db.cards), {});
  assert.deepEqual(plain(t.db.trades), {});
  assert.equal(t.db.prices.C1.sales.length, 3);
  assert.equal(t.db.userId, 'U1');
});
