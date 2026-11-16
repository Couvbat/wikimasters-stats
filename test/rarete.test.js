// Tests : prix par rareté. Une même carte se vend à plusieurs raretés : chaque vente et chaque annonce garde la sienne,
// et la valeur se calcule à partir des seules ventes de la bonne rareté.
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain, fakeFile } = require('./harness');

const BASE = Date.parse('2026-11-15T00:00:00Z');
const T = i => new Date(BASE - i * 36e5).toISOString(); // i heures avant le 15/11 à minuit
const MIN = 6e4;

// ----- Tâche 1 : les ventes gardent leur rareté -----
test('ingestSales lit les 200 ventes et garde ses ventes par rareté (20 pour L)', () => {
  const { t } = load();
  const sales = [];
  for (let i = 0; i < 25; i++) sales.push({ id: 'L' + i, final_price: 13000 + i, settled_at: T(i), rarity: 'L' });
  for (let i = 0; i < 3; i++) sales.push({ id: 'U' + i, final_price: 7000 + i, settled_at: T(30 + i), rarity: 'UR' });
  t.ingestSales('C', { recent: sales.slice(0, 10), sales });
  const got = t.db.prices.C.sales;
  assert.equal(got.filter(s => s.r === 'L').length, 20);
  assert.equal(got.filter(s => s.r === 'UR').length, 3);
  assert.equal(got.length, 23);
  assert.equal(got[0].p, 13000);
});

test('prix provisoires, prix finaux et ventes perso gardent la rareté de l’exemplaire', () => {
  const { t } = load();
  const end = Date.now() - 5 * MIN;
  t.db.obs = { A1: ['C', 30, 1, end, end - MIN, 'UR'] };
  t.settleObserved();
  assert.equal(t.db.obsSales.C[0].r, 'UR');
  t.db.finQ = { A2: ['D', 'L', end, 1] };
  t.ingestFinal('A2', { auction: { card_id: 'D', final_price: 40, settled_at: T(1), snapshot_rarity: 'SR' } });
  assert.equal(t.db.obsSales.D[0].r, 'SR');
  t.db.auctions = { H: ['s', 'E', 'X', 'UR', 5, 5, 77, T(1), 0] };
  t.tidyAuctions();
  assert.equal(t.db.mySales.E[0].r, 'UR');
});

test('fichier ami : la rareté des ventes fait l’aller-retour ; un ancien fichier sans rareté reste accepté', async () => {
  const a = load().t;
  a.db.me = 'Jules';
  a.db.cards = { x: { cardId: 'C', title: 'C', rarity: 'L', count: 1 } };
  a.db.prices = { C: { at: 100, sales: [{ p: 13000, t: T(1), r: 'L' }, { p: 7000, t: T(2), r: 'UR' }] } };
  a.db.obsSales = { D: [{ p: 50, t: T(3), g: 0, i: 'A9', x: 1, r: 'SR' }] };
  const b = load().t;
  b.ui.el.frStatus = { textContent: '' };
  await b.importFriend(fakeFile(JSON.stringify(a.friendExport('Jules'))));
  assert.deepEqual(plain(b.db.prices.C.sales.map(s => s.r)), ['L', 'UR']);
  assert.equal(b.db.obsSales.D[0].r, 'SR');
  const old = { wmstats: 1, pseudo: 'Paul', at: 1, cards: [['Z', 'Z', 'R', 1]], pro: [['Y', 100, [[5, T(1)]], 'Paul']], seen: { sales: [['W', 5, T(1), 0, 1, 'Z1']] } };
  const c = load().t;
  c.ui.el.frStatus = { textContent: '' };
  await c.importFriend(fakeFile(JSON.stringify(old)));
  assert.deepEqual(plain(c.db.prices.Y.sales), [{ p: 5, t: T(1) }]);
  assert.equal(c.db.obsSales.W[0].r, undefined);
});

test('la sauvegarde conserve la rareté des ventes', () => {
  const { t } = load();
  t.mergeBackup(JSON.stringify({ wmstatsBackup: 1, at: 1, data: { prices: { C: { at: 100, sales: [{ p: 5, t: T(1), r: 'L' }] } } } }));
  assert.equal(t.db.prices.C.sales[0].r, 'L');
});

// ----- Tâche 2 : la valeur se calcule par rareté -----
function mixedCard(t) {
  const sales = [];
  for (let i = 0; i < 9; i++) sales.push({ p: 13000 + i * 100, t: T(i), r: 'L' });
  sales.push({ p: 7000, t: T(20), r: 'UR' });
  t.db.prices = { C: { at: Date.now(), sales } };
}

test('priceOf : médiane des seules ventes de la rareté demandée, prix mélangé signalé sinon', () => {
  const { t } = load();
  mixedCard(t);
  const l = t.priceOf('C', 'L');
  assert.equal(l.n, 9);
  assert.equal(l.med, 13400);
  assert.equal(l.mixed, false);
  const ur = t.priceOf('C', 'UR');
  assert.equal(ur.n, 1);
  assert.equal(ur.med, 7000);
  const sr = t.priceOf('C', 'SR');
  assert.equal(sr.mixed, true);
  assert.equal(sr.n, 10);
  assert.equal(sr.rel.level, 0);
  assert.match(t.relCell(sr).title, /autres raretés/);
});

test('priceOf sans rareté : celle de la collection ; carte inconnue : toutes les ventes', () => {
  const { t } = load();
  mixedCard(t);
  t.db.cards = { x: { cardId: 'C', title: 'C', rarity: 'L', count: 1 } };
  assert.equal(t.priceOf('C').med, 13400);
  t.db.prices.Z = { at: Date.now(), sales: [{ p: 10, t: T(1), r: 'L' }, { p: 30, t: T(2), r: 'UR' }] };
  const z = t.priceOf('Z');
  assert.equal(z.n, 2);
  assert.equal(z.mixed, false);
});

test('anciennes ventes sans rareté : elles servent quand aucune vente de la bonne rareté n’existe', () => {
  const { t } = load();
  t.db.prices = { C: { at: Date.now(), sales: [{ p: 100, t: T(1) }, { p: 120, t: T(2) }, { p: 999, t: T(3), r: 'UR' }] } };
  const p = t.priceOf('C', 'L');
  assert.equal(p.med, 110);
  assert.equal(p.mixed, false);
});

test('sources : l’historique Pro n’a que des UR, les ventes observées ont des L : on prend les observées', () => {
  const { t } = load();
  t.db.prices = { C: { at: Date.now(), sales: [{ p: 7000, t: T(1), r: 'UR' }] } };
  t.db.obsSales = { C: [{ p: 13000, t: T(2), g: 0, x: 1, r: 'L' }, { p: 14000, t: T(3), g: 0, x: 1, r: 'L' }] };
  const p = t.priceOf('C', 'L');
  assert.equal(p.med, 13500);
  assert.equal(p.obs, true);
  assert.equal(p.mixed, false);
});

// ----- Tâche 3 : les annonces gardent leur rareté -----
test('askOf : la ligne d’une carte L présente l’annonce L, même si une UR est moins chère', () => {
  const { t } = load();
  const now = Date.now();
  t.ingestMarket({ auctions: [
    { id: 'U1', card_id: 'C', base_amount: 400, effective_bid: 400, end_at: new Date(now + 3600e3).toISOString(), snapshot_rarity: 'UR', card: { wikipedia_title: 'C', rarity: 'L' } },
    { id: 'L1', card_id: 'C', base_amount: 12000, effective_bid: 12000, end_at: new Date(now + 7200e3).toISOString(), snapshot_rarity: 'L', card: { wikipedia_title: 'C', rarity: 'L' } }
  ] });
  const ask = t.askOf('C', 'L');
  assert.equal(ask.a, 12000);
  assert.equal(ask.r, 'L');
  assert.equal(ask.other, 1);
  assert.deepEqual(plain(ask.list.map(x => [x.a, x.r])), [[400, 'UR'], [12000, 'L']]);
  assert.equal(t.rarityOf('C'), 'L', 'la rareté de la carte vient aussi des enchères vues');
});

test('bonne affaire : une annonce UR se compare à la valeur UR, jamais à la valeur L', () => {
  const { t } = load();
  mixedCard(t);
  const ur = { a: 400, r: 'UR' };
  assert.equal(t.dealPct(ur, t.priceOf('C', ur.r)), 0, 'une seule vente UR : pas assez pour parler de bonne affaire');
  t.db.prices.C.sales.push({ p: 7100, t: T(21), r: 'UR' }, { p: 6900, t: T(22), r: 'UR' });
  t.resetPrices();
  assert.equal(t.dealPct(ur, t.priceOf('C', ur.r)), 94);
});

test('pastille : une annonce UR affiche la valeur UR', () => {
  const { t } = load();
  mixedCard(t);
  const b = t.badgeFor('C', { a: 400, r: 'UR', b: false }, {});
  assert.match(b.text, /7[\s  ]?000/);
});

// ----- Tâche 4 : la rareté de chaque vente circule dans le pool -----
test('poolPull garde la rareté de chaque vente reçue', async () => {
  const { reply } = require('./harness');
  const POOL = 'https://pool.test';
  const env = load({ fast: true, fetch: async url => (url === POOL + '/v1/pull'
    ? reply({ cards: { C1: { pro: { at: Date.now() - MIN, by: 'Marie', sales: [[13000, T(1), 'L'], [7000, T(2), 'UR']] }, sales: [[45, T(3), 0, 1, 'A1', 'UR']] } } })
    : reply({})) });
  const t = env.t;
  Object.assign(t.db.pool, { url: POOL, key: 'cle-du-groupe-assez-longue-123', on: true });
  await t.poolPull(['C1']);
  assert.deepEqual(plain(t.db.prices.C1.sales.map(s => s.r)), ['L', 'UR']);
  assert.equal(t.db.obsSales.C1[0].r, 'UR');
  assert.equal(t.priceOf('C1', 'L').med, 13000);
});
