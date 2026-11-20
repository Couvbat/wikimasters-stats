// Tests de la fiche par carte (1.29.0). Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');
const DAY = 864e5, NOW = Date.now();
const iso = d => new Date(NOW - d * DAY).toISOString();
const sale = (d, p, r = 'SR', more = {}) => Object.assign({ p, t: iso(d), r }, more);
const nb = s => String(s).replace(/[  ]/g, ' ');
const textOf = n => (n == null || n === false ? '' : Array.isArray(n) ? n.map(textOf).join(' ')
  : typeof n === 'object' ? (n.textContent || '') + ' ' + (n.children || []).map(textOf).join(' ') : String(n));
const find = (n, pred, out = []) => {
  if (Array.isArray(n)) { for (const k of n) find(k, pred, out); return out; }
  if (n && typeof n === 'object') { if (pred(n)) out.push(n); for (const k of n.children || []) find(k, pred, out); }
  return out;
};

// ----- Tâche 1 : la source des ventes -----
test('source de la fiche : celle de priceOf, avec toutes ses ventes (l’historique Pro passe devant les prix observés)', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: Array.from({ length: 12 }, (_, i) => sale(i * 5, 100 + i)) };
  t.db.obsSales.C1 = [sale(1, 50, 'SR', { x: 1, i: 'A1' }), sale(2, 55, 'SR', { x: 1, i: 'A2' })];
  const src = t.cardSource('C1', 'SR');
  assert.equal(src.kind, 'pro');
  assert.equal(src.sales.length, 12);
  assert.equal(t.priceOf('C1', 'SR').nAll, 12, 'priceOf repose sur la même source');
});

test('source de la fiche : tes ventes sans historique Pro, sinon les prix observés', () => {
  const { t } = load();
  t.db.obsSales.C1 = [sale(1, 50, 'SR', { x: 1, i: 'A1' })];
  assert.equal(t.cardSource('C1', 'SR').kind, 'obs');
  t.db.mySales.C1 = [sale(3, 70)];
  assert.equal(t.cardSource('C1', 'SR').kind, 'own');
});

test('source de la fiche : aucune vente à la rareté voulue, pas de mélange ; les raretés qui ont des ventes', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 900, 'UR'), sale(2, 950, 'L')] };
  assert.deepEqual(plain(t.cardSource('C1', 'SR')), { kind: null, sales: [] });
  assert.equal(t.priceOf('C1', 'SR').mixed, true, 'priceOf, lui, se rabat sur les autres raretés');
  assert.deepEqual(plain(t.cardRarities('C1')), ['L', 'UR']);
});
