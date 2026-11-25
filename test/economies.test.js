// Tests : économies de calcul (1.31.0). Les données ne sont réécrites qu'une fois par rafale d'enregistrements, et un nouveau
// dessin du panneau garde les prix déjà calculés des cartes qui n'ont pas changé.
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fakeBus, fire } = require('./harness');

const KEY = 'wmstats.v1';
const DAY = 864e5;
const tick = () => new Promise(r => setImmediate(r));
const latest = idbData => JSON.parse(idbData.get(KEY) || '{}').latest;

// ----- enregistrement -----
test('IndexedDB : plusieurs enregistrements de suite ne réécrivent les données qu’une fois, à la fin de la rafale', async () => {
  const env = load({ idb: {} });
  await env.ready;
  const { t, idbData, idbStats } = env;
  const tx0 = idbStats.tx;
  for (const v of ['9.9.1', '9.9.2', '9.9.3']) {
    t.db.latest = v;
    t.saveDb();
    await tick();
  }
  assert.equal(idbStats.tx, tx0, 'rien n’est encore écrit');
  await t.store.idle();
  assert.equal(idbStats.tx, tx0 + 1, 'une seule écriture');
  assert.equal(latest(idbData), '9.9.3', 'la dernière version des données');
});

test('IndexedDB : l’enregistrement en attente part dès que l’onglet est caché, ou quitté', async () => {
  const env = load({ idb: {} });
  await env.ready;
  const { t, idbData, document, window } = env;
  const encoded = () => JSON.parse(t.store.get(KEY) || '{}').latest; // le texte gardé en mémoire, écrit dans la base juste après
  const written = async v => { for (let i = 0; i < 50 && latest(idbData) !== v; i++) await tick(); return latest(idbData); };
  t.db.latest = '9.9.4';
  t.saveDb();
  await tick();
  assert.notEqual(encoded(), '9.9.4', 'pas encore');
  document.visibilityState = 'hidden';
  fire(document, 'visibilitychange');
  assert.equal(encoded(), '9.9.4', 'onglet caché : remis en texte tout de suite');
  assert.equal(await written('9.9.4'), '9.9.4', 'puis écrit');
  document.visibilityState = 'visible';
  t.db.latest = '9.9.5';
  t.saveDb();
  fire(window, 'pagehide');
  assert.equal(encoded(), '9.9.5', 'page quittée : tout de suite');
  assert.equal(await written('9.9.5'), '9.9.5');
});

test('IndexedDB : un changement de compte enregistre d’abord les données de l’ancien compte, telles quelles', async () => {
  const env = load({ idb: {} });
  await env.ready;
  const { t, idbData } = env;
  t.setAccount('U1');
  t.db.cards = { x1: { cardId: 'A', title: 'A', rarity: 'R', count: 1 } };
  t.saveDb();
  t.setAccount('U2');
  await t.store.idle();
  assert.deepEqual(Object.keys(JSON.parse(idbData.get(KEY + '.u.U1')).cards), ['x1'], 'la collection de U1 est rangée sous U1');
  assert.deepEqual(Object.keys(JSON.parse(idbData.get(KEY + '.u.U2')).cards), [], 'et pas sous U2');
});

test('IndexedDB : un autre onglet qui enregistre ne fait pas perdre un enregistrement encore en attente ici', async () => {
  const data = new Map(), bus = fakeBus();
  const a = load({ idb: { data, bus } }), b = load({ idb: { data, bus } });
  await a.ready;
  await b.ready;
  a.t.db.pool.url = 'A';
  a.t.saveDb(); // en attente dans A
  b.t.db.latest = '9.9.6';
  b.t.saveDb();
  await b.t.store.idle(); // B écrit et prévient A
  for (let i = 0; i < 30; i++) await tick();
  assert.equal(a.t.db.pool.url, 'A', 'A ne recharge pas par-dessus son changement');
  await a.t.store.idle();
  assert.equal(JSON.parse(data.get(KEY)).pool.url, 'A');
});

// ----- prix -----
const recent = (n, p0) => Array.from({ length: n }, (_, i) => ({ p: p0 + i, t: new Date(Date.now() - (i + 1) * 3600e3).toISOString(), g: 0, x: 1 }));

test('prix : un nouveau dessin du panneau garde les prix déjà calculés des cartes qui n’ont pas changé', () => {
  const { t, document } = load();
  document.querySelectorAll = () => [];
  t.ui.el.host = {}; // panneau monté, fermé
  t.db.obsSales.C1 = recent(5, 100);
  t.db.obsSales.C2 = recent(5, 200);
  const c1 = t.priceOf('C1'), c2 = t.priceOf('C2');
  t.refresh();
  assert.equal(t.priceOf('C1'), c1, 'C1 n’est pas recalculée');
  assert.equal(t.priceOf('C2'), c2, 'C2 non plus');
  // Une vente de plus pour C2 : son prix est recalculé, celui de C1 reste.
  t.db.obsSales.C2 = t.db.obsSales.C2.concat(recent(1, 900));
  t.refresh();
  assert.notEqual(t.priceOf('C2'), c2);
  assert.equal(t.priceOf('C2').n, 6);
  assert.equal(t.priceOf('C1'), c1);
});

test('prix : une liste de ventes qui change sur place (une vente ajoutée) est recalculée, même sans nouveau dessin', () => {
  const { t } = load();
  t.db.obsSales.C1 = recent(5, 100);
  const c1 = t.priceOf('C1');
  t.db.obsSales.C1.push({ p: 500, t: new Date(Date.now() - 30 * 60e3).toISOString(), g: 0, x: 1 });
  assert.equal(t.priceOf('C1').n, 6);
  // Un relevé Pro remplace la source : recalculée aussi.
  t.db.prices.C1 = { at: Date.now(), sales: recent(5, 300).map(({ p, t: ts }) => ({ p, t: ts })) };
  assert.equal(t.priceOf('C1').obs, false);
  assert.notEqual(t.priceOf('C1'), c1);
});

test('prix : la rareté d’une carte apprise après coup (collection) est prise au dessin suivant', () => {
  const { t, document } = load();
  document.querySelectorAll = () => [];
  t.ui.el.host = {};
  t.db.obsSales.C1 = recent(5, 100).map(s => Object.assign(s, { r: 'R' })).concat(recent(5, 1000).map(s => Object.assign(s, { r: 'L' })));
  assert.equal(t.priceOf('C1').mixed, false);
  assert.equal(t.priceOf('C1').r, '');
  t.db.cards = { x1: { cardId: 'C1', title: 'C1', rarity: 'L', count: 1 } };
  t.refresh();
  assert.equal(t.priceOf('C1').r, 'L');
  assert.ok(t.priceOf('C1').med >= 1000);
});
