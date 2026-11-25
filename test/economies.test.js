// Tests : économies de calcul. 1.31.0 : un nouveau dessin du panneau garde les prix déjà calculés des cartes qui n'ont pas changé.
// 1.32.0 : les données étant rangées carte par carte (test/stockage-cartes.test.js), l'enregistrement repart tout de suite, regroupé
// par tâche, au lieu d'attendre jusqu'à 5 secondes comme en 1.31.
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, reply, fire } = require('./harness');

const KEY = 'wmstats.v1';
const DAY = 864e5;
const tick = () => new Promise(r => setImmediate(r));
const latest = idbData => JSON.parse(idbData.get(KEY) || '{}').latest;

// ----- enregistrement -----
test('IndexedDB : enregistré au tour suivant, sans attendre ; plusieurs saveDb dans la même tâche, une seule écriture', async () => {
  const env = load({ idb: {} });
  await env.ready;
  const { t, idbData, idbStats } = env;
  const tx0 = idbStats.tx;
  t.db.latest = '9.9.1';
  t.saveDb();
  t.db.latest = '9.9.2';
  t.saveDb();
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(latest(idbData), '9.9.2', 'écrit sans attendre store.idle');
  assert.equal(idbStats.tx, tx0 + 1, 'une seule écriture pour la tâche');
});

test('IndexedDB : un enregistrement demandé juste avant que l’onglet soit caché, ou quitté, est remis en texte aussitôt', async () => {
  const env = load({ idb: {} });
  await env.ready;
  const { t, document, window } = env;
  const encoded = () => JSON.parse(t.store.get(KEY) || '{}').latest; // le texte gardé en mémoire, écrit dans la base juste après
  t.db.latest = '9.9.4';
  t.saveDb();
  document.visibilityState = 'hidden';
  fire(document, 'visibilitychange');
  assert.equal(encoded(), '9.9.4', 'onglet caché');
  document.visibilityState = 'visible';
  t.db.latest = '9.9.5';
  t.saveDb();
  fire(window, 'pagehide');
  assert.equal(encoded(), '9.9.5', 'page quittée (un dernier essai : Chrome ne finit pas toujours cette écriture)');
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

// 1.31.1 : une écriture de plus de 10 Mo commencée quand la page se ferme n'a pas le temps de finir (vu dans Chrome). La fin d'un
// relevé et celle d'une réception du pool enregistrent donc tout de suite, sans attendre les 5 secondes.
const T = '2026-11-25T10:00:00.000Z';
test('fin d’un relevé de prix : enregistré tout de suite, sans attendre 5 secondes', async () => {
  const fetch = async url => reply(/\/sales/.test(url) ? { recent: [{ final_price: 77, settled_at: T, rarity: 'R' }] } : {});
  const env = load({ idb: {}, fetch });
  await env.ready;
  const { t } = env;
  t.db.userId = 'U1';
  await t.fetchPricesFor([['C7', 'R']], 'status', 'carte', 'cartes');
  assert.ok(t.store.get(KEY + '.p.C7'), 'le prix relevé est déjà remis en texte (son entrée, 1.32)');
});

test('fin d’une réception du pool : enregistrée tout de suite, sans attendre 5 secondes', async () => {
  const fetch = async () => reply({ pool: 'p1', max: 1, next: 1, more: false, sales: [[1, 'C9', 42, T, 'exact', 'A1', 0, null]], pro: [], unsold: [] });
  const env = load({ idb: {}, fetch });
  await env.ready;
  const { t } = env;
  Object.assign(t.db.pool, { url: 'https://pool.test/', key: 'cle-du-groupe-assez-longue-123', on: true });
  await t.poolFeed(true);
  assert.ok(t.db.obsSales.C9, 'la vente est reçue');
  assert.ok(t.store.get(KEY + '.o.C9'), 'et déjà remise en texte (son entrée, 1.32)');
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

test('prix : un prix gardé se refait quand la fiabilité ou l’âge affiché de la dernière vente change avec le temps', () => {
  let now = Date.parse('2026-11-25T12:00:00Z');
  const { t } = load({ clock: () => now });
  const old = d => Array.from({ length: 5 }, (_, i) => ({ p: 100 + i, t: new Date(now - d * DAY - i * 60e3).toISOString(), g: 0, x: 1 }));
  t.db.obsSales.C1 = old(29.2); // 5 ventes d'il y a 29 jours : fiable
  assert.equal(t.priceOf('C1').rel.level, 2);
  assert.equal(Math.round(t.priceOf('C1').rel.age), 29);
  now += 0.5 * DAY; // 29,7 jours : l'âge affiché passe à 30
  assert.equal(Math.round(t.priceOf('C1').rel.age), 30);
  assert.equal(t.priceOf('C1').rel.level, 2);
  now += 1 * DAY; // 30,7 jours : plus de 30 jours, moyen
  assert.equal(t.priceOf('C1').rel.level, 1);
  now += 60 * DAY; // 90,7 jours : douteux
  assert.equal(t.priceOf('C1').rel.level, 0);
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
