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

// ----- Tâche 2 : les repères -----
const base5 = p => [10, 12, 14, 16, 18].map(d => sale(d, p));
// Prix qui évolue de `weekly` par semaine : 1000 ₩ aujourd'hui, n ventes espacées de 3,5 jours à partir d'hier.
const trend = (weekly, n = 8) => Array.from({ length: n }, (_, i) => { const d = 1 + i * 3.5; return sale(d, Math.round(1000 * Math.pow(1 + weekly, -d / 7))); });

test('repère 1 : plus cher, moins cher, dans son habitude', () => {
  const { t } = load();
  const m = sales => t.cardCues(sales, NOW, null).moment;
  let c = m([sale(1, 130), sale(2, 130), sale(3, 130), ...base5(100)]);
  assert.equal(c.state, 'high'); assert.equal(c.pct, 30);
  c = m([sale(1, 80), sale(2, 80), sale(3, 80), ...base5(100)]);
  assert.equal(c.state, 'low'); assert.equal(c.pct, -20);
  assert.equal(m([sale(1, 105), sale(2, 105), sale(3, 105), ...base5(100)]).state, 'usual');
  const line = nb(t.cueLines(t.cardCues([sale(1, 80), sale(2, 80), sale(3, 80), ...base5(100)], NOW, null))[0].text);
  assert.match(line, /^moins cher que d’habitude \(−20 %\) · 7 derniers jours : 80 ₩ \(3 ventes\), 30 jours d’avant : 100 ₩ \(5 ventes\)$/);
});

test('repère 1 : pas assez de ventes pour comparer', () => {
  const { t } = load();
  const m = sales => t.cardCues(sales, NOW, null).moment.state;
  assert.equal(m([sale(1, 130), sale(2, 130), ...base5(100)]), 'few', '2 ventes sur 7 jours');
  assert.equal(m([sale(1, 130), sale(2, 130), sale(3, 130), ...base5(100).slice(0, 4)]), 'few', '4 ventes sur les 30 jours d’avant');
  assert.equal(nb(t.cueLines(t.cardCues([sale(1, 130)], NOW, null))[0].text), 'pas assez de ventes pour comparer');
});

test('repère 2 : en hausse, en baisse, stable', () => {
  const { t } = load();
  const s = sales => t.cardCues(sales, NOW, null).slope;
  let c = s(trend(0.10));
  assert.equal(c.state, 'up'); assert.ok(c.pct >= 9 && c.pct <= 11, String(c.pct));
  c = s(trend(-0.10));
  assert.equal(c.state, 'down'); assert.ok(c.pct <= -9 && c.pct >= -11, String(c.pct));
  assert.equal(s(trend(0.01)).state, 'flat');
  assert.equal(nb(t.cueLines(t.cardCues(trend(-0.10), NOW, null))[1].text), 'en baisse (−10 % par semaine)');
});

test('repère 2 : une vente aberrante ne renverse pas le sens ; moins de 6 ventes, pas de sens', () => {
  const { t } = load();
  const s = sales => t.cardCues(sales, NOW, null).slope.state;
  assert.equal(s([sale(0.5, 50000), ...trend(-0.10)]), 'down');
  assert.equal(s(trend(0.10, 5)), 'few');
});

test('repère 3 : environ N fois par semaine, par mois, ou aucune vente en 30 jours', () => {
  const { t } = load();
  const pace = sales => nb(t.cueLines(t.cardCues(sales, NOW, null))[2].text);
  assert.equal(pace(Array.from({ length: 9 }, (_, i) => sale(1 + i * 3, 100))), 'se vend environ 2 fois par semaine · dernière vente il y a 1 j');
  assert.match(pace([sale(2, 100), sale(9, 100), sale(20, 100)]), /^se vend environ 3 fois par mois · /);
  assert.equal(pace([sale(40, 100), sale(45, 100)]), 'aucune vente en 30 jours · dernière vente il y a 40 j');
});

test('repère 4 : la concurrence à la bonne rareté seulement, avec l’âge du relevé', () => {
  const { t } = load();
  const list = [{ a: 120, b: false, r: 'SR', i: 'A1' }, { a: 50, b: true, r: 'UR', i: 'A2' }, { a: 150, b: false, r: 'SR', i: 'A3' }];
  const line = asks => nb(t.cueLines(t.cardCues([sale(1, 100)], NOW, asks)).find(l => l.k === 'compete').text);
  assert.equal(line({ list, rarity: 'SR', seenAt: NOW - 2 * 36e5 }), '2 en vente, la moins chère à 120 ₩ · relevé il y a 2 h');
  assert.equal(line({ list: list.slice(1, 2), rarity: 'SR', seenAt: NOW - 3 * 36e5 }), 'aucune annonce connue à cette rareté (relevé il y a 3 h)');
  assert.equal(line({ list: [], rarity: 'SR', seenAt: 0 }), 'annonces jamais cherchées');
  assert.equal(t.cueLines(t.cardCues([sale(1, 100)], NOW, null)).some(l => l.k === 'compete'), false);
});

test('repères en court pour la bulle', () => {
  const { t } = load();
  assert.equal(nb(t.cueShort(t.cardCues([sale(1, 130), sale(2, 130), sale(3, 130), ...base5(100)], NOW, null))), 'plus cher que d’habitude · en hausse');
  assert.equal(t.cueShort(t.cardCues([sale(1, 100)], NOW, null)), '');
});

test('repères : date illisible ignorée, date future comptée comme maintenant, ventes à la même date', () => {
  const { t } = load();
  const odd = [{ p: 100, t: 'n/a', r: 'SR' }, sale(-2, 130), sale(1, 130), sale(2, 130), ...base5(100)];
  const c = t.cardCues(odd, NOW, null);
  assert.equal(c.moment.n7, 3);
  assert.equal(c.moment.state, 'high');
  const same = Array.from({ length: 8 }, () => sale(3, 100));
  assert.equal(t.cardCues(same, NOW, null).slope.state, 'few', 'aucune paire de dates différentes');
  for (const s of [odd, same]) assert.doesNotMatch(t.cueLines(t.cardCues(s, NOW, null)).map(l => l.text).join(' '), /NaN|undefined|Infinity/);
});
