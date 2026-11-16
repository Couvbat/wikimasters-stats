// Tests : l'onglet Souhaits quand le navigateur est presque plein.
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const KEY = 'wmstats.v1';
const T = i => new Date(Date.parse('2026-11-15T00:00:00Z') - i * 36e5).toISOString();
const sales = n => Array.from({ length: n }, (_, i) => ({ p: 100 + i, t: T(i), r: 'L' }));
const auction = (id, card, price, rarity) => ({
  id, card_id: card, base_amount: price, effective_bid: price, end_at: new Date(Date.now() + 3600e3).toISOString(),
  snapshot_rarity: rarity, card: { wikipedia_title: card, rarity }
});

// Un navigateur où l'historique des prix tient encore, mais plus le relevé du marché à côté.
function nearlyFull() {
  let limit = Infinity;
  const env = load({ reject: s => s.length > limit });
  const { t, store } = env;
  t.db.wish = { W1: ['Coluche', 'L'] };
  t.db.prices = {};
  for (let c = 0; c < 200; c++) t.db.prices['C' + c] = { at: 1, sales: sales(20) };
  assert.equal(t.saveDb(), true);
  limit = store.get(KEY).length + 3000;
  return env;
}
const others = n => Array.from({ length: n }, (_, i) => auction('X' + i, 'O' + i, 50 + i, 'C'));

test('navigateur presque plein : les annonces trouvées restent affichées', () => {
  const { t } = nearlyFull();
  t.ingestMarket({ auctions: [auction('A1', 'W1', 2679, 'L'), ...others(40)] });
  const ask = t.askOf('W1', 'L');
  assert.ok(ask, 'l’annonce de la carte souhaitée doit rester connue');
  assert.equal(ask.a, 2679);
  assert.ok(t.askOf('O0'), 'les autres annonces aussi, jusqu’au rechargement de la page');
});

test('navigateur presque plein : les annonces des cartes souhaitées survivent au rechargement', () => {
  const { t, store } = nearlyFull();
  t.ingestMarket({ auctions: [auction('A1', 'W1', 2679, 'L'), ...others(40)] });
  const saved = JSON.parse(store.get(KEY)).market.asks;
  assert.ok(saved.W1, 'l’annonce de la carte souhaitée est enregistrée');
  assert.equal(saved.W1.a, 2679);
  assert.equal(saved.O0, undefined, 'les autres annonces ne sont plus enregistrées : c’est la place qui manquait');
  t.db = t.loadDb();
  t.resetPrices();
  assert.equal(t.askOf('W1', 'L').a, 2679);
  assert.equal(t.db.prices.C0.sales.length, 20, 'l’historique des prix n’a pas été raccourci pour autant');
});

test('navigateur avec de la place : tout le relevé du marché est enregistré', () => {
  const { t, store } = load();
  t.db.wish = { W1: ['Coluche', 'L'] };
  t.ingestMarket({ auctions: [auction('A1', 'W1', 2679, 'L'), ...others(3)] });
  assert.deepEqual(Object.keys(JSON.parse(store.get(KEY)).market.asks).sort(), ['O0', 'O1', 'O2', 'W1']);
});
