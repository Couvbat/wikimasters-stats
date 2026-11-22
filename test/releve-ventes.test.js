// Relevé des ventes d'une carte (1.29.1). Depuis sa mise à jour de novembre 2026, le site ne renvoie plus que les 5 dernières
// ventes (« recent », chacune avec sa rareté), filtrables par rareté. Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, reply, plain } = require('./harness');
const T = '2026-11-22T10:00:00.000Z';

test('relevé : les ventes sont demandées à la rareté voulue, sans rareté quand elle est inconnue', async () => {
  const urls = [];
  const { t } = load({ fast: true, fetch: async url => { urls.push(url); return reply({ recent: [{ id: 'S1', final_price: 100, settled_at: T, rarity: 'SR' }] }); } });
  await t.fetchSales('C1', 'SR');
  await t.fetchSales('C2', '?');
  await t.fetchSales('C3', '');
  assert.deepEqual(urls, ['/api/marketplace/cards/C1/sales?rarity=SR', '/api/marketplace/cards/C2/sales', '/api/marketplace/cards/C3/sales']);
  assert.equal(t.db.prices.C1.sales[0].r, 'SR');
});

// ----- Relecture Copilot : la date d'un relevé et les files de relevé, par couple carte-rareté -----
const H = 36e5, DAY = 864e5;
const settle = async () => { for (let i = 0; i < 100; i++) await new Promise(r => setImmediate(r)); };
// Site simulé : chaque relevé renvoie une vente à la rareté demandée. sales() : les relevés demandés, sans le préfixe.
function salesEnv() {
  const urls = [];
  const env = load({ fast: true, fetch: async url => {
    urls.push(url);
    const r = (/[?&]rarity=([A-Z]+)/.exec(url) || [])[1] || 'C';
    return reply({ recent: [{ id: 'S' + urls.length, final_price: 10, settled_at: T, rarity: r }] });
  } });
  env.t.db.userId = 'U1';
  env.t.db.pro = { U1: true };
  return Object.assign(env, { sales: () => urls.filter(u => u.includes('/sales')).map(u => u.replace('/api/marketplace/cards/', '')) });
}

test('relevé : la date d’un relevé vaut pour sa rareté seulement', () => {
  const { t } = load();
  t.ingestSales('C1', { recent: [{ id: 'S1', final_price: 10, settled_at: T, rarity: 'C' }] }, 'C');
  assert.equal(t.priceDue('C1', 'C'), false);
  assert.equal(t.priceDue('C1', 'SR'), true, 'SR jamais relevée');
});

test('relevé : une rareté restée sans vente est redemandée après une heure, même si d’autres raretés en ont', () => {
  const { t } = load();
  t.db.prices.C1 = { at: Date.now() - 2 * H, ats: { C: Date.now(), SR: Date.now() - 2 * H }, sales: [{ p: 10, t: T, r: 'C' }] };
  assert.equal(t.priceDue('C1', 'SR'), true);
  assert.equal(t.priceDue('C1', 'C'), false);
});

test('relevé : un relevé d’avant 1.29.1, sans date par rareté, vaut encore pour toutes les raretés', () => {
  const { t } = load();
  t.db.prices.C1 = { at: Date.now() - H, sales: [{ p: 10, t: T, r: 'C' }, { p: 50, t: T, r: 'SR' }] };
  assert.equal(t.priceDue('C1', 'SR'), false);
  assert.equal(t.priceDue('C1', 'C'), false);
});

test('relevé : un relevé reçu du pool ne rend récente aucune rareté qui n’a pas été relevée ici', () => {
  const { t } = load();
  t.db.prices.C1 = { at: Date.now() - 3 * DAY, ats: { C: Date.now() - 3 * DAY }, sales: [{ p: 10, t: T, r: 'C' }] };
  t.mergePro([['C1', Date.now(), [[50, T, 'SR']], 'Paul']]);
  assert.equal(t.priceDue('C1', 'SR'), true);
});

test('Relever les prix : chaque rareté cochée d’une même carte est demandée à sa rareté', async () => {
  const env = salesEnv();
  env.t.db.cards = { a: { cardId: 'C1', title: 'X', rarity: 'SR', count: 1 }, b: { cardId: 'C1', title: 'X', rarity: 'C', count: 1 } };
  env.t.ui.chosen = new Set(['SR']);
  await env.t.fillPrices();
  assert.deepEqual(env.sales(), ['C1/sales?rarity=SR']);
  env.t.ui.chosen = new Set(['SR', 'C']);
  await env.t.fillPrices();
  assert.deepEqual(env.sales(), ['C1/sales?rarity=SR', 'C1/sales?rarity=C']);
});

test('échanges : la même carte à deux raretés donne deux relevés', () => {
  const { t } = load();
  t.db.trades = { T1: { s: 'accepted', t: T, g: [['C1', 'X', 'SR']], r: [['C1', 'X', 'C']] } };
  assert.deepEqual(plain(t.tradeCardsToPrice()), [['C1', 'SR'], ['C1', 'C']]);
});

test('enchères : la même carte à deux raretés donne deux relevés', async () => {
  const env = salesEnv();
  env.t.db.ov.bidAuto = true;
  env.t.queueBidPrices([{ id: 'A1', card_id: 'C1', snapshot_rarity: 'SR' }, { id: 'A2', card_id: 'C1', snapshot_rarity: 'C' }]);
  await settle();
  assert.deepEqual(env.sales(), ['C1/sales?rarity=SR', 'C1/sales?rarity=C']);
});

test('boosters : la même carte tirée à deux raretés donne deux relevés', async () => {
  const env = salesEnv();
  env.t.onPull([{ card: { id: 'C1', wikipedia_title: 'X', rarity: 'SR' } }, { card: { id: 'C1', wikipedia_title: 'X', rarity: 'C' } }], 'standard');
  await settle();
  assert.deepEqual(env.sales(), ['C1/sales?rarity=SR', 'C1/sales?rarity=C']);
});

// ----- 1.30.0 : le relevé pour tout compte reconnu -----
test('compte non Pro : boosters et enchères relèvent aussi leurs prix', async () => {
  const env = salesEnv();
  env.t.db.pro = { U1: false };
  env.t.db.ov.bidAuto = true;
  env.t.onPull([{ card: { id: 'B1', wikipedia_title: 'X', rarity: 'SR' } }], 'standard');
  await settle();
  env.t.queueBidPrices([{ id: 'A1', card_id: 'E1', snapshot_rarity: 'C' }]);
  await settle();
  assert.deepEqual(env.sales(), ['B1/sales?rarity=SR', 'E1/sales?rarity=C']);
});

test('compte pas encore reconnu : aucun relevé, et le message le dit', async () => {
  const env = salesEnv();
  env.t.db.userId = '';
  env.t.ui.el.wishStatus = { textContent: '' };
  await env.t.fetchPricesFor([['C1', 'SR']], 'wishStatus', 'carte', 'cartes');
  assert.deepEqual(env.sales(), []);
  assert.match(env.t.ui.el.wishStatus.textContent, /^Compte pas encore reconnu/);
});

test('aucun texte ne réserve plus les relevés aux comptes Pro', () => {
  const fs = require('fs'), path = require('path');
  for (const f of ['wikimasters-stats.user.js', 'README.md']) {
    const txt = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(txt, /réservée?s? (?:au|aux comptes) Pro|compte Pro uniquement|\(Pro\)|Relever l’historique Pro/, f);
  }
});
