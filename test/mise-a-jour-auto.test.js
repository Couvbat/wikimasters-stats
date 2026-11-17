// Tests : mise à jour automatique (prix relus selon leur valeur, routine, bouton « Tout mettre à jour maintenant »).
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const H = 36e5, DAY = 24 * H;
const iso = ms => new Date(ms).toISOString();
// Un prix relu il y a « age » ms, avec n ventes de la rareté r au prix p.
const priced = (age, r, p = 10, n = 3) => ({ at: Date.now() - age, sales: Array.from({ length: n }, (_, i) => ({ p, t: iso(Date.now() - age - i * H), r })) });
const card = (cardId, rarity, count = 1) => ({ cardId, title: 'Carte ' + cardId, rarity, count });

// ----- Tâche 1 : quand relire, dans quel ordre -----
test('priceDue : délais par rareté', () => {
  const { t } = load();
  const due = (r, age) => { t.db.prices = { X: priced(age, r, 5) }; t.resetPrices(); return t.priceDue('X', r); };
  assert.equal(due('L', 25 * H), true);
  assert.equal(due('L', 23 * H), false);
  assert.equal(due('SR', 47 * H), false);
  assert.equal(due('SR', 49 * H), true);
  assert.equal(due('R', 3 * DAY), false);
  assert.equal(due('R', 5 * DAY), true);
  assert.equal(due('C', 6 * DAY), false);
  assert.equal(due('C', 8 * DAY), true);
});

test('priceDue : une carte qui vaut plus de 50 ₩ ou en vente se relit chaque jour', () => {
  const { t } = load();
  t.db.prices = { V: priced(25 * H, 'R', 60), W: priced(25 * H, 'R', 40), S: priced(25 * H, 'C', 2) };
  t.resetPrices();
  assert.equal(t.priceDue('V', 'R'), true, 'R à 60 ₩');
  assert.equal(t.priceDue('W', 'R'), false, 'R à 40 ₩ : 4 jours');
  assert.equal(t.priceDue('S', 'C'), false);
  t.db.selling = [{ i: 'a1', c: 'S', t: 'S', r: 'C' }];
  assert.equal(t.priceDue('S', 'C'), true, 'en vente');
});

test('priceDue : sans prix, et historique vide douteux', () => {
  const { t } = load();
  t.db.prices = { E: { at: Date.now() - 2 * H, sales: [] } };
  assert.equal(t.priceDue('N', 'C'), true, 'jamais relue');
  assert.equal(t.priceDue('E', 'L'), true, 'L sans vente depuis 2 h');
});

test('dueCards : de la plus lourde à la plus légère', () => {
  const { t } = load();
  t.db.cards = { a: card('A', 'C', 5), b: card('B', 'C'), r: card('R1', 'R'), n: card('N', 'R'), p: card('P', 'PC') };
  t.db.prices = { A: priced(8 * DAY, 'C', 10), B: priced(8 * DAY, 'C', 100), R1: priced(1 * H, 'R', 30) };
  t.resetPrices();
  const list = t.dueCards();
  const ids = list.map(x => x[0]);
  assert.ok(ids.indexOf('B') < ids.indexOf('A'), '100 × 1 avant 10 × 5');
  assert.equal(list.find(x => x[0] === 'N')[2], 30, 'jamais relue : la médiane de sa rareté');
  assert.equal(list.find(x => x[0] === 'P')[2], 1, 'aucune PC connue : poids 1, mais présente');
  assert.ok(!ids.includes('R1'), 'relue il y a une heure');
});

test('dueCards : les souhaits en vente comptent, une seule fois', () => {
  const { t } = load();
  const ask = id => ({ a: 5, b: false, e: Date.now() + H, i: 'au' + id, t: Date.now(), r: 'L', list: [{ i: 'au' + id, a: 5, b: false, e: Date.now() + H, r: 'L' }] });
  t.db.wish = { W1: ['Souhait', 'L'], W2: ['Possédé', 'L'], W3: ['Pas en vente', 'L'] };
  t.db.market.asks = { W1: ask('W1'), W2: ask('W2') };
  t.db.cards = { w2: card('W2', 'L') };
  const ids = t.dueCards().map(x => x[0]);
  assert.ok(ids.includes('W1'));
  assert.equal(ids.filter(id => id === 'W2').length, 1);
  assert.ok(!ids.includes('W3'));
});

test('Relever les prix suit priceDue', () => {
  const { t } = load();
  t.ui.chosen = new Set(['L', 'UR', 'SR', 'R', 'PC', 'C']);
  t.db.cards = { c: card('C1', 'C'), l: card('L1', 'L') };
  t.db.prices = { C1: priced(3 * DAY, 'C', 2), L1: priced(25 * H, 'L', 5) };
  t.resetPrices();
  assert.deepEqual([...t.missingIds()], ['L1']);
});
