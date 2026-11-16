// Tests : profit des ventes. Pour chaque carte vendue ou en vente, son origine (achetée, tirée d'un booster, reçue par échange)
// et ce qu'elle rapporte : prix de vente moins coût.
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');

const H = 36e5, D = 24 * H;
const now = Date.now();
const iso = ms => new Date(ms).toISOString();
const listing = (id, card, { base = 100, bid = null, rarity = 'SR', shiny = false, title = card, createdAgo = H } = {}) => ({
  id, card_id: card, base_amount: base, listing_base_amount: base, current_bid: bid, effective_bid: bid == null ? base : bid,
  end_at: iso(now + 3 * H), created_at: iso(now - createdAgo), snapshot_rarity: rarity, is_shiny: shiny, card: { wikipedia_title: title, rarity }
});
const textOf = n => (n == null ? '' : typeof n === 'string' || typeof n === 'number' ? String(n)
  : (n.textContent || '') + (n.children || []).map(textOf).join(' ') + (n.k || []).map(textOf).join(' '));

test('origine : un achat avant la mise en vente donne son prix ; un achat après ne compte pas', () => {
  const { t } = load();
  t.db.auctions = {
    B1: ['b', 'C1', 'X', 'SR', 300, 300, 320, iso(now - 3 * D), 0],
    B2: ['b', 'C1', 'X', 'SR', 900, 900, 950, iso(now + D), 0]
  };
  const o = plain(t.originOf('C1', 'SR', false, now));
  assert.equal(o.kind, 'buy');
  assert.equal(o.cost, 320);
});

test('origine : la plus récente gagne, à la bonne rareté ; booster = 0 ₩', () => {
  const { t } = load();
  t.db.auctions = { B1: ['b', 'C1', 'X', 'SR', 300, 300, 320, iso(now - 5 * D), 0], B3: ['b', 'C1', 'X', 'L', 5000, 5000, 5100, iso(now - D), 0] };
  t.db.pulls = [{ t: now - 2 * D, k: 'open', c: [['C1', 'X', 'SR']] }];
  const o = plain(t.originOf('C1', 'SR', false, now));
  assert.equal(o.kind, 'pull');
  assert.equal(o.cost, 0);
  assert.equal(t.originOf('C1', 'L', false, now).cost, 5100);
});

test('origine : un achat shiny ne compte pas pour un exemplaire normal', () => {
  const { t } = load();
  t.db.auctions = { B1: ['b', 'C1', 'X', 'SR', 300, 300, 999, iso(now - D), 1] };
  assert.equal(t.originOf('C1', 'SR', false, now), null);
  assert.equal(t.originOf('C1', 'SR', true, now).cost, 999);
});

test('origine : un échange accepté coûte ≈ ce qu’on a donné, réparti entre les cartes reçues', () => {
  const { t } = load();
  t.db.prices = { G1: { at: now, sales: [0, 1, 2].map(() => ({ p: 200, t: iso(now), r: 'UR' })) } };
  t.db.trades = {
    T1: { s: 'accepted', t: iso(now - D), w: 'Paul', ini: 1, g: [['G1', 'Donnée', 'UR']], r: [['C1', 'X', 'SR'], ['C9', 'Y', 'R']], wg: 100, wr: 0 },
    T2: { s: 'declined', t: iso(now - H), w: 'Zoé', ini: 1, g: [], r: [['C1', 'X', 'SR']], wg: 0, wr: 0 }
  };
  const o = plain(t.originOf('C1', 'SR', false, now));
  assert.equal(o.kind, 'trade');
  assert.equal(o.who, 'Paul');
  assert.equal(o.cost, 150);
  assert.equal(o.approx, true);
});

test('origine inconnue quand rien ne correspond', () => {
  const { t } = load();
  assert.equal(t.originOf('NADA', 'SR', false, now), null);
});

test('ventes en cours : profit = prix actuel − coût, et total sur les annonces d’origine connue', () => {
  const { t } = load();
  t.db.auctions = { B1: ['b', 'C1', 'X', 'SR', 300, 300, 320, iso(now - 3 * D), 0] };
  t.db.pulls = [{ t: now - 2 * D, k: 'open', c: [['C2', 'Y', 'R']] }];
  t.ingestMarket({ selling: [
    listing('A1', 'C1', { base: 300, bid: 450, rarity: 'SR' }),
    listing('A2', 'C2', { base: 80, rarity: 'R' }),
    listing('A3', 'C3', { base: 50, rarity: 'C' })
  ] });
  assert.ok(t.db.selling[0].at > 0 && t.db.selling[0].at < now);
  const rows = t.sellingRows();
  assert.equal(rows[0].profit, 130);
  assert.equal(rows[1].profit, 80);
  assert.equal(rows[2].profit, null);
  const s = t.sellingStats(rows);
  assert.equal(s.profit, 210);
  assert.equal(s.unknownOrigin, 1);
});

test('affichage : colonnes Origine et Profit dans les ventes en cours et les ventes terminées', () => {
  const { t } = load();
  const out = {};
  t.ui.el.salesTiles = { replaceChildren(...k) { out.tiles = k; } };
  t.ui.el.salesBody = { replaceChildren(...k) { out.body = k; } };
  t.ui.el.sellingBody = { replaceChildren(...k) { out.selling = k; } };
  t.db.auctions = {
    B1: ['b', 'C1', 'X', 'SR', 300, 300, 320, iso(now - 9 * D), 0],
    S1: ['s', 'C1', 'X', 'SR', 400, 400, 500, iso(now - 2 * D), 0]
  };
  t.ingestMarket({ selling: [listing('A1', 'C1', { base: 300, bid: 450, rarity: 'SR', title: 'Lil Peep' })] });
  t.renderSales();
  const live = textOf({ k: out.selling }), done = textOf({ k: out.body });
  assert.match(live, /achetée/);
  assert.match(live, /Profit/);
  assert.match(done, /Profit/);
  assert.match(done, /\+180/);
});
