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

// ----- Tâche 2 : valeur récente (7 jours, 3 ventes au moins) ou depuis toujours -----
const ventes = (n, p, d, r = 'L') => Array.from({ length: n }, (_, i) => ({ p, t: iso(ago(d) - i * H), r }));

test('la récente compte quand il y a assez de ventes', () => {
  const { t } = load();
  t.db.prices = { C1: { at: Date.now(), sales: ventes(4, 100, 1).concat(ventes(30, 300, 20)) } };
  const p = t.priceOf('C1', 'L');
  assert.equal(p.med, 100);
  assert.equal(p.n, 4);
  assert.equal(p.basis, 'recent');
  assert.equal(p.nRecent, 4);
  assert.equal(p.medAll, 300);
  assert.equal(p.nAll, 34);
});

test('pas assez de ventes récentes : depuis toujours', () => {
  const { t } = load();
  t.db.prices = { C1: { at: Date.now(), sales: ventes(2, 100, 1).concat(ventes(30, 300, 20)) } };
  const p = t.priceOf('C1', 'L');
  assert.equal(p.med, 300);
  assert.equal(p.basis, 'all');
  assert.equal(p.medRecent, 100);
  assert.equal(p.nRecent, 2);
});

test('une vente d’il y a 7 jours compte encore, une de 7 jours et une heure non', () => {
  const { t } = load();
  const at = (ms, p) => ({ p, t: iso(ms), r: 'L' });
  const edge = Date.now() - 7 * DAY + 5000;
  t.db.prices = { C1: { at: Date.now(), sales: [at(edge, 100), at(edge - 1, 100), at(edge - 2, 100)] } };
  assert.equal(t.priceOf('C1', 'L').basis, 'recent');
  const late = Date.now() - 7 * DAY - H;
  t.db.prices = { C2: { at: Date.now(), sales: [at(late, 100), at(late - 1, 100), at(late - 2, 100)] } };
  assert.equal(t.priceOf('C2', 'L').basis, 'all');
});

test('récentes d’une autre rareté : pas de valeur récente ici', () => {
  const { t } = load();
  t.db.prices = { C1: { at: Date.now(), sales: ventes(5, 900, 1, 'UR').concat(ventes(10, 300, 20)) } };
  const p = t.priceOf('C1', 'L');
  assert.equal(p.basis, 'all');
  assert.equal(p.nRecent, 0);
  assert.equal(p.medRecent, null);
  assert.equal(p.med, 300);
});

// ----- Tâche 4 : afficher les deux valeurs -----
const text = x => (x == null || x === false ? '' : Array.isArray(x) ? x.map(text).join('') : typeof x === 'object' ? (x.textContent || '') + (x.children || []).map(text).join('') : String(x));
const nbsp = s => s.replace(/[\u00a0\u202f]/g, ' ');

test('pastille : les deux valeurs', () => {
  const { t } = load();
  t.db.prices = { C1: { at: Date.now(), sales: ventes(4, 100, 1).concat(ventes(30, 300, 20)) } };
  let lines = t.badgeFor('C1', null, {}).lines.map(nbsp).join('\n');
  assert.match(lines, /Valeur : 100 ₩ \(7 derniers jours, 4 ventes/);
  assert.match(lines, /Depuis toujours : 300 ₩ \(34 ventes\)/);
  t.db.prices = { C1: { at: Date.now(), sales: ventes(2, 100, 1).concat(ventes(30, 300, 20)) } };
  t.resetPrices();
  lines = t.badgeFor('C1', null, {}).lines.map(nbsp).join('\n');
  assert.match(lines, /Valeur : 300 ₩ \(depuis toujours, 32 ventes/);
  assert.match(lines, /7 derniers jours : 100 ₩ \(2 ventes\)/);
});

test('Collection : marque « 7 j » et colonnes « 7 jours » et « Depuis toujours »', () => {
  const { t } = load();
  t.db.prices = { C1: { at: Date.now(), sales: ventes(4, 100, 1).concat(ventes(30, 300, 20)) } };
  const col = k => t.COLS.find(c => c.k === k);
  assert.equal(col('recent').t, '7 jours');
  assert.equal(col('all').t, 'Depuis toujours');
  const ks = t.COLS.map(c => c.k);
  assert.deepEqual([...ks.slice(ks.indexOf('value'), ks.indexOf('value') + 3)], ['value', 'recent', 'all']);
  const price = t.priceOf('C1', 'L');
  const r = { price, value: 100, est: false };
  assert.match(nbsp(text(col('value').cell(r))), /^100 · 7 j$/);
  assert.equal(nbsp(text(col('recent').cell(r))), '100 ₩ · 4 ventes');
  assert.equal(nbsp(text(col('all').cell(r))), '300 ₩ · 34 ventes');
  assert.equal(col('recent').get(r), 100);
  assert.equal(col('all').get(r), 300);
  const none = { price: null, value: 1, est: true };
  assert.equal(text(col('recent').cell(none)), '—');
  assert.equal(col('all').get(none), null);
  t.db.prices.C2 = { at: Date.now(), sales: ventes(10, 300, 20) };
  const old = { price: t.priceOf('C2', 'L'), value: 300, est: false };
  assert.equal(text(col('value').cell(old)).includes('7 j'), false, 'valeur depuis toujours : pas de marque');
  assert.equal(text(col('value').cell(none)).includes('7 j'), false, 'sans vente : pas de marque');
});
