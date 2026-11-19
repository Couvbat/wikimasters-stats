// Tests : toutes les ventes gardées et additionnées, valeur récente (7 jours) ou depuis toujours.
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');

const H = 36e5, DAY = 24 * H;
const iso = ms => new Date(ms).toISOString();
const ago = d => Date.now() - d * DAY;
const site = (list, r = 'L') => ({ sales: list.map(([p, t]) => ({ final_price: p, settled_at: t, rarity: r })) });

// ----- Tâche 1 : garder toutes les ventes, et les additionner -----
test('keepAll : trie, dédoublonne, plafonne à 2 000', () => {
  const { t } = load();
  const a = t.keepAll([{ p: 5, t: '2026-11-15T10:00:00Z', r: 'L' }, { p: 5, t: '2026-11-15T10:00:00.000Z', r: 'L' }, { p: 6, t: '2026-11-16T10:00:00.000Z', r: 'L' }]);
  assert.equal(a.length, 2, 'la même vente écrite de deux façons compte une fois');
  assert.equal(a[0].p, 6, 'la plus récente d’abord');
  const many = Array.from({ length: 2001 }, (_, i) => ({ p: 1, t: iso(Date.parse('2026-01-01T00:00:00Z') + i * H), r: 'C' }));
  const b = t.keepAll(many);
  assert.equal(b.length, 2000);
  assert.ok(!b.some(s => s.t === many[0].t), 'la plus ancienne en moins');
});

test('relevés Pro qui s’accumulent', () => {
  const { t } = load();
  const A = iso(ago(5)), B = iso(ago(4)), C = iso(ago(3)), D = iso(ago(2)), E = iso(ago(1));
  t.ingestSales('C1', site([[10, A], [11, B], [12, C]]));
  t.ingestSales('C1', site([[12, C], [13, D], [14, E]]));
  assert.equal(t.db.prices.C1.sales.length, 5);
  t.ingestSales('C1', { sales: [] });
  assert.equal(t.db.prices.C1.sales.length, 5, 'une relecture vide ne change rien');
});

test('plus de plafond par rareté', () => {
  const { t } = load();
  t.ingestSales('C1', site(Array.from({ length: 75 }, (_, i) => [100 + i, iso(ago(i + 1))])));
  assert.equal(t.db.prices.C1.sales.length, 75);
});

test('mergePro : union des ventes, auteur du relevé le plus récent', () => {
  const { t } = load();
  t.db.prices = { C1: { at: 1000, sales: [{ p: 1, t: iso(ago(3)), r: 'L' }, { p: 2, t: iso(ago(2)), r: 'L' }, { p: 3, t: iso(ago(1)), r: 'L' }] } };
  t.mergePro([['C1', 2000, [[3, iso(ago(1)), 'L'], [4, iso(ago(0.5)), 'L']]]], 'Paul');
  assert.equal(t.db.prices.C1.sales.length, 4);
  assert.equal(t.db.prices.C1.at, 2000);
  assert.equal(t.db.prices.C1.by, 'Paul');
  t.mergePro([['C1', 500, [[9, iso(ago(10)), 'L']]]], 'Marie');
  assert.equal(t.db.prices.C1.sales.length, 5, 'un relevé plus ancien ajoute ses ventes');
  assert.equal(t.db.prices.C1.at, 2000);
  assert.equal(t.db.prices.C1.by, 'Paul');
});

test('mode secours : trimHistory raccourcit toujours', () => {
  const { t } = load();
  t.db.prices = { C1: { at: 1, sales: Array.from({ length: 30 }, (_, i) => ({ p: i + 1, t: iso(ago(i + 1)), r: 'L' })) } };
  t.trimHistory();
  assert.equal(t.db.prices.C1.sales.length, 10);
});

test('une vente sans rareté déjà connue avec sa rareté compte une fois', () => {
  const { t } = load();
  const A = iso(ago(2)), B = iso(ago(1));
  t.ingestSales('C1', site([[10, A], [11, B]]));
  t.ingestSales('C1', { recent: [{ final_price: 11, settled_at: B }, { final_price: 12, settled_at: iso(ago(0.5)) }] });
  assert.equal(t.db.prices.C1.sales.length, 3);
});
