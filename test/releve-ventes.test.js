// Relevé des ventes d'une carte (1.29.1). Depuis sa mise à jour de novembre 2026, le site ne renvoie plus que les 5 dernières
// ventes (« recent », chacune avec sa rareté), filtrables par rareté. Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, reply } = require('./harness');
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
