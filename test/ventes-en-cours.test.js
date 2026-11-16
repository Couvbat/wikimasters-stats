// Tests : tes mises en vente en cours, gardées en mémoire et résumées en haut de l'onglet Mes ventes.
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');

const H = 36e5;
const T = '2026-11-15T10:00:00.000Z';
// Une annonce telle que le site la renvoie dans « selling ».
const listing = (id, card, { base = 100, listing = base, bid = null, endIn = 3 * H, rarity = 'SR', shiny = false, title = card } = {}) => ({
  id, card_id: card, base_amount: base, listing_base_amount: listing, current_bid: bid, effective_bid: bid == null ? base : bid,
  end_at: new Date(Date.now() + endIn).toISOString(), snapshot_rarity: rarity, is_shiny: shiny, card: { wikipedia_title: title, rarity }
});
// Valeur médiane d'une carte, à une rareté : trois ventes au même prix.
const priced = (t, card, r, p) => { t.db.prices[card] = { at: Date.now(), sales: [0, 1, 2].map(i => ({ p, t: T, r })) }; };
// Tout le texte d'un élément rendu (éléments simulés du harnais et chaînes).
const textOf = n => (n == null ? '' : typeof n === 'string' || typeof n === 'number' ? String(n)
  : (n.textContent || '') + (n.children || []).map(textOf).join(' ') + (n.k || []).map(textOf).join(' '));

test('les annonces en cours sont gardées, et une page sans « selling » ne les efface pas', () => {
  const { t } = load();
  t.ingestMarket({ selling: [listing('A1', 'C1', { base: 300, listing: 400, bid: 450, title: 'Lil Peep' }), listing('A2', 'C2')], maxConcurrentAuctions: 5 });
  assert.equal(t.db.selling.length, 2);
  const a = plain(t.db.selling[0]);
  assert.deepEqual({ i: a.i, c: a.c, t: a.t, r: a.r, base: a.base, l: a.l, o: a.o, b: a.b, s: a.s }, { i: 'A1', c: 'C1', t: 'Lil Peep', r: 'SR', base: 300, l: 400, o: 450, b: true, s: 0 });
  assert.ok(a.e > Date.now());
  assert.equal(t.db.selling[1].o, null);
  assert.deepEqual(plain(t.db.market.selling), ['C1', 'C2']);
  t.ingestMarket({ auctions: [], page: 2 });
  assert.equal(t.db.selling.length, 2);
});

test('bilan : offres, revenu, valeur à la rareté de l’exemplaire, shiny exclue, annonces terminées ignorées', () => {
  const { t } = load();
  priced(t, 'UP', 'SR', 400);   // offre 450 > valeur 400
  priced(t, 'DOWN', 'L', 1000); // offre 600 < valeur 1000
  priced(t, 'HIGH', 'UR', 200); // pas d'offre, mise de départ 500 > valeur 200
  priced(t, 'SHINY', 'SR', 300);
  t.ingestMarket({ selling: [
    listing('A1', 'UP', { base: 300, bid: 450, rarity: 'SR' }),
    listing('A2', 'DOWN', { base: 500, bid: 600, rarity: 'L' }),
    listing('A3', 'HIGH', { base: 500, rarity: 'UR' }),
    listing('A4', 'SHINY', { base: 100, bid: 900, rarity: 'SR', shiny: true }),
    listing('A5', 'UP', { base: 10, bid: 20, endIn: -H })
  ], maxConcurrentAuctions: 5 });
  const s = t.sellingStats(t.sellingRows());
  assert.equal(s.live.length, 4);
  assert.equal(s.withOffer.length, 3);
  assert.equal(s.overBase.length, 3);
  assert.equal(s.revenue, 450 + 600 + 900);
  assert.equal(s.value, 400 + 1000 + 200);
  assert.deepEqual(plain(s.below.map(r => r.i)), ['A2']);
  assert.deepEqual(plain(s.highBase.map(r => r.i)), ['A3']);
  assert.equal(s.free, 1);
});

test('une carte sans prix connu n’est ni dans la valeur ni sous la valeur', () => {
  const { t } = load();
  t.ingestMarket({ selling: [listing('A1', 'NOPRICE', { base: 50, bid: 60 })] });
  const s = t.sellingStats(t.sellingRows());
  assert.equal(s.value, 0);
  assert.equal(s.unknown, 1);
  assert.equal(s.below.length, 0);
});

test('l’onglet Mes ventes affiche les annonces en cours même sans enchère terminée en mémoire', () => {
  const { t } = load();
  const out = {};
  t.ui.el.salesTiles = { replaceChildren(...k) { out.tiles = k; } };
  t.ui.el.salesBody = { replaceChildren(...k) { out.body = k; } };
  t.ui.el.sellingBody = { replaceChildren(...k) { out.selling = k; } };
  t.ingestMarket({ selling: [listing('A1', 'C1', { title: 'Lil Peep', bid: 450 }), listing('A2', 'C2', { title: 'Keisha' })], maxConcurrentAuctions: 5 });
  t.db.auctions = {};
  t.renderSales();
  const text = textOf({ k: [...(out.selling || []), ...(out.tiles || []), ...(out.body || [])] });
  assert.match(text, /Mes ventes en cours/);
  assert.match(text, /Lil Peep/);
  assert.match(text, /Keisha/);
});

test('les annonces en cours sont propres à chaque compte', () => {
  const { t } = load();
  t.ingestPro('U1', [{ is_pro: true }]);
  t.ingestMarket({ selling: [listing('A1', 'C1')] });
  t.saveDb();
  t.ingestPro('U2', [{ is_pro: false }]);
  assert.deepEqual(plain(t.db.selling), []);
  t.ingestPro('U1', [{ is_pro: true }]);
  assert.equal(t.db.selling.length, 1);
});

// ----- Remarques de relecture -----
const stubSales = t => {
  const out = {};
  t.ui.el.salesTiles = { replaceChildren(...k) { out.tiles = k; } };
  t.ui.el.salesBody = { replaceChildren(...k) { out.body = k; } };
  t.ui.el.sellingBody = { replaceChildren(...k) { out.selling = k; } };
  return out;
};

test('aucune valeur vide passée à l’affichage quand il n’y a pas encore d’enchère terminée', () => {
  const { t } = load();
  const out = stubSales(t);
  t.ingestMarket({ selling: [listing('A1', 'C1')] });
  t.db.auctions = {};
  t.renderSales();
  assert.ok(out.selling.length > 0);
  assert.ok(out.selling.every(x => x != null), 'replaceChildren afficherait « null »');
});

test('écart d’une demi-unité sous la valeur : affiché en rouge avec son signe, jamais « +0 ₩ »', () => {
  const { t } = load();
  const out = stubSales(t);
  t.db.prices.HALF = { at: Date.now(), sales: [{ p: 100, t: T, r: 'SR' }, { p: 101, t: T, r: 'SR' }] }; // médiane 100,5
  t.ingestMarket({ selling: [listing('A1', 'HALF', { base: 50, bid: 100, rarity: 'SR' })] });
  t.db.auctions = {};
  t.renderSales();
  const s = t.sellingStats(t.sellingRows());
  assert.equal(s.below.length, 1);
  const text = textOf({ k: out.selling });
  assert.doesNotMatch(text, /\+0 ₩/);
  assert.match(text, /−0,5 ₩/);
});

test('une annonce qui se termine pendant que l’onglet est ouvert sort des tuiles à la minute suivante', () => {
  const { t } = load();
  const out = stubSales(t);
  t.ui.el.host = null;
  t.ui.open = true;
  t.ui.tab = 'sales';
  t.ingestMarket({ selling: [listing('A1', 'C1', { endIn: H })], maxConcurrentAuctions: 5 });
  t.db.auctions = {};
  t.renderSales();
  assert.match(textOf({ k: out.selling }), /dans /);
  t.db.selling[0].e = Date.now() - 1000; // l'enchère vient de finir, sans nouvelle réponse du Marché
  t.minuteTick();
  const text = textOf({ k: out.selling });
  assert.match(text, /terminée/);
  assert.equal(t.sellingStats(t.sellingRows()).live.length, 0);
});
