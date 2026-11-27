// Tests : la case « Cacher les annonces trop chères » de l'onglet Souhaits (1.33.0). Une annonce est trop chère quand son prix atteint
// déjà la valeur médiane de sa rareté, comme le badge « trop cher » de l'onglet.
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');

const KEY = 'wmstats.v1';
const later = Date.now() + 3600e3;
const au = (i, a, r = 'L') => ({ i, a, b: false, e: later, r });
// La ligne d'une carte L valant 100 ₩, avec ses annonces (la moins chère d'abord, comme askOf).
const row = (list, price = { n: 5, med: 100, r: 'L' }) => ({ id: 'W1', title: 'X', rarity: 'L', price,
  ask: { a: list[0].a, b: false, e: later, i: list[0].i, t: Date.now(), r: list[0].r, list, other: 0 } });

test('trop chère : les annonces au prix de la valeur ou au-dessus sont retirées, la moins chère restante devient celle de la ligne', () => {
  const { t } = load();
  const c = t.withoutDear(row([au('A1', 80), au('A2', 100), au('A3', 150)]));
  assert.deepEqual(plain(c.ask.list).map(x => x.i), ['A1']);
  assert.equal(c.ask.a, 80);
  assert.equal(c.ask.i, 'A1');
});

test('trop chère : une carte dont toutes les annonces sont trop chères disparaît', () => {
  const { t } = load();
  assert.equal(t.withoutDear(row([au('A2', 100), au('A3', 150)])), null);
});

test('trop chère : sans valeur connue, ou sans annonce, la carte reste telle quelle', () => {
  const { t } = load();
  const unknown = row([au('A3', 150)], null);
  assert.equal(t.withoutDear(unknown), unknown);
  const none = { id: 'W2', title: 'Y', rarity: 'L', price: { n: 5, med: 100, r: 'L' }, ask: null };
  assert.equal(t.withoutDear(none), none);
});

test('trop chère : une annonce d’une autre rareté se compare à la valeur de sa propre rareté', () => {
  const { t } = load();
  const T = new Date(Date.now() - 36e5).toISOString();
  t.db.obsSales.W1 = Array.from({ length: 5 }, (_, k) => ({ p: 200, t: T, g: 0, x: 1, r: 'UR' }));
  // L'exemplaire UR à 300 ₩ dépasse la valeur UR (200 ₩) : retiré, même s'il est sous la valeur L (1 000 ₩).
  const c = t.withoutDear(row([au('U1', 300, 'UR'), au('A1', 900, 'L')], { n: 5, med: 1000, r: 'L' }));
  assert.deepEqual(plain(c.ask.list).map(x => x.i), ['A1']);
  assert.equal(c.ask.a, 900);
  assert.equal(c.ask.other, 0);
});

test('la case reste cochée d’une visite à l’autre, pour ce compte', () => {
  const env = load();
  env.t.db.wishHideDear = true;
  env.t.saveDb();
  const storage = Object.fromEntries(env.store);
  assert.equal(JSON.parse(storage[KEY + '.u._']).wishHideDear, true, 'rangée avec les données de ce compte');
  assert.equal(JSON.parse(storage[KEY]).wishHideDear, undefined, 'pas dans la partie commune à tous les comptes');
  const again = load({ storage });
  assert.equal(again.t.db.wishHideDear, true);
});

test('onglet Souhaits : la case cochée retire la carte dont toutes les annonces sont trop chères, l’autre reste', () => {
  const { t } = load();
  const T = new Date(Date.now() - 36e5).toISOString(), box = () => ({ style: {}, textContent: '', replaceChildren(...k) { this.kids = k; } });
  for (const k of ['wishTiles', 'wishBody', 'wishFold', 'bidBody', 'bidTiles', 'bidStatus']) t.ui.el[k] = box();
  t.db.wish = { W1: ['Pas chère', 'L'], W2: ['Trop chère', 'L'] };
  for (const id of ['W1', 'W2']) t.db.obsSales[id] = Array.from({ length: 5 }, () => ({ p: 100, t: T, g: 0, x: 1, r: 'L' }));
  const now = Date.now();
  t.db.market.asks = { W1: { t: now, list: [{ i: 'A1', a: 60, b: false, e: now + 36e5, r: 'L' }] }, W2: { t: now, list: [{ i: 'A2', a: 140, b: false, e: now + 36e5, r: 'L' }] } };
  const shown = () => { t.renderWish(); return JSON.stringify(plain(t.ui.el.wishBody.kids)); };
  assert.ok(shown().includes('Trop chère') && shown().includes('Pas chère'), 'case décochée : les deux');
  t.db.wishHideDear = true;
  const s = shown();
  assert.ok(s.includes('Pas chère'), 'la carte à 60 ₩ reste');
  assert.ok(!s.includes('Trop chère'), 'la carte à 140 ₩ (valeur 100 ₩) disparaît');
});
