// Tests : données rangées dans IndexedDB (sans la limite de 5 Mo du localStorage), migration vérifiée, mode secours.
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, reply, fakeBus } = require('./harness');

const KEY = 'wmstats.v1';

// ----- Tâche 1 : couche store en mode local -----
test('mode local sans indexedDB : store.get lit le localStorage et storeLine le dit', () => {
  const { t } = load({ storage: { [KEY]: '{"prices":{}}' } });
  assert.equal(t.store.mode, 'local');
  assert.equal(t.store.loaded, true);
  assert.equal(t.store.get(KEY), '{"prices":{}}');
  assert.match(t.storeLine(), /^Rangées dans le stockage du site \(limité à 5 Mo\) : 0,0 Mo\.$/);
});

test('mode local : la ligne des comptes compte les clés wmstats.v1.u.*, sans _', () => {
  const { t } = load({ storage: { [KEY]: '{"prices":{}}', [KEY + '.u.U1']: '{}', [KEY + '.u.U2']: '{}', [KEY + '.u._']: '{}', 'wmstats.auto': '{}' } });
  assert.equal(t.store.keys().filter(k => k.startsWith(KEY + '.u.') && k !== KEY + '.u._').length, 2);
  assert.ok(!t.store.keys().includes('wmstats.auto'), 'seules les clés de la base');
});

// ----- Tâche 2 : ouverture de la base, chargement et migration -----
const sharedText = url => JSON.stringify({ userId: 'U1', prices: { C1: { at: 1, sales: [] } }, pool: { url } });
const mineText = (id, card) => JSON.stringify({ cards: { [id]: { cardId: card, title: card, rarity: 'R', count: 1 } } });

test('migration de deux comptes : copie identique, ancien stockage effacé sauf wmstats.auto', async () => {
  const shared = sharedText('http://127.0.0.1:8787'), u1 = mineText('x1', 'A'), u2 = mineText('x2', 'B');
  const env = load({ idb: {}, storage: { [KEY]: shared, [KEY + '.u.U1']: u1, [KEY + '.u.U2']: u2, 'wmstats.auto': '{"at":1}' } });
  assert.equal(env.t.store.loaded, false, 'pas encore chargé');
  await env.ready;
  const { t, idbData } = env;
  assert.equal(t.store.mode, 'idb');
  assert.equal(t.store.loaded, true);
  assert.equal(idbData.get(KEY), shared);
  assert.equal(idbData.get(KEY + '.u.U1'), u1);
  assert.equal(idbData.get(KEY + '.u.U2'), u2);
  assert.deepEqual([...env.store.keys()], ['wmstats.auto'], 'il ne reste que le verrou de la collecte automatique');
  assert.deepEqual(Object.keys(t.db.cards), ['x1']);
  assert.equal(t.db.pool.url, 'http://127.0.0.1:8787');
});

test('migration de l’ancien format d’avant la 1.20 : copié tel quel, collection lue', async () => {
  const legacy = JSON.stringify({ userId: 'U1', prices: {}, cards: { x1: { cardId: 'A', title: 'A', rarity: 'R', count: 1 } } });
  const env = load({ idb: {}, storage: { [KEY]: legacy } });
  await env.ready;
  assert.equal(env.idbData.get(KEY), legacy);
  assert.deepEqual(Object.keys(env.t.db.cards), ['x1']);
});

test('relecture différente : rien n’est effacé, mode local', async () => {
  const shared = sharedText('L'), u1 = mineText('x1', 'A');
  const env = load({ idb: { corruptReads: true }, storage: { [KEY]: shared, [KEY + '.u.U1']: u1 } });
  await env.ready;
  assert.equal(env.t.store.mode, 'local');
  assert.equal(env.store.get(KEY), shared);
  assert.equal(env.store.get(KEY + '.u.U1'), u1);
  assert.equal(env.t.db.pool.url, 'L');
  assert.deepEqual(Object.keys(env.t.db.cards), ['x1']);
});

const META = 'wmstats.meta';
test('base déjà remplie : elle fait foi, les clés restantes du localStorage sont effacées', async () => {
  const data = new Map([[KEY, sharedText('A')], [META, '{"since":1}']]);
  const env = load({ idb: { data }, storage: { [KEY]: sharedText('B'), 'wmstats.auto': '{"at":1}' } });
  await env.ready;
  assert.equal(env.t.db.pool.url, 'A');
  assert.equal(env.store.has(KEY), false);
  assert.equal(env.store.has('wmstats.auto'), true);
});

test('open qui lève une exception : mode local, rien ne plante', async () => {
  const env = load({ idb: { openThrows: true }, storage: { [KEY]: sharedText('L') } });
  await env.ready;
  assert.equal(env.t.store.mode, 'local');
  assert.equal(env.t.db.pool.url, 'L');
  assert.equal(env.store.has(KEY), true, 'rien n’est effacé');
});

test('rien nulle part : défauts, mode idb', async () => {
  const env = load({ idb: {} });
  await env.ready;
  assert.equal(env.t.store.mode, 'idb');
  assert.equal(env.t.store.loaded, true);
  assert.deepEqual(Object.keys(env.t.db.prices), []);
  assert.deepEqual([...env.idbData.keys()], [META], 'seul le marqueur : la base fait foi désormais');
});

test('vérification qui échoue après la copie : la copie ne fait pas foi, les changements suivants sont gardés', async () => {
  const data = new Map();
  let reads = 0;
  const first = load({ idb: { data, failReads: () => ++reads === 2 }, storage: { [KEY]: sharedText('L1') } });
  await first.ready;
  assert.equal(first.t.store.mode, 'local');
  first.t.db.pool.url = 'L2';
  first.t.saveDb();
  const second = load({ idb: { data }, storage: Object.fromEntries(first.store) });
  await second.ready;
  assert.equal(second.t.store.mode, 'idb');
  assert.equal(second.t.db.pool.url, 'L2', 'les changements faits en mode local sont gardés');
  assert.match(data.get(KEY), /"url":"L2"/);
  assert.ok(data.has(META));
});

// ----- Tâche 3 : enregistrement dans la base, attente du chargement -----
const gated = () => { let open; const gate = new Promise(r => { open = r; }); return { gate, open }; };
const tick = () => new Promise(r => setImmediate(r));

test('saveDb avant le chargement n’écrit rien, nulle part', async () => {
  const data = new Map([[KEY, sharedText('A')]]);
  const g = gated();
  const env = load({ idb: { data, gate: g.gate } });
  assert.equal(env.t.saveDb(), true);
  assert.equal(env.store.size, 0, 'rien dans le localStorage non plus');
  g.open();
  await env.ready;
  await env.t.store.idle();
  assert.equal(data.get(KEY), sharedText('A'), 'la base n’a pas été remplacée par des données vides');
  assert.equal(env.t.db.pool.url, 'A');
});

test('plusieurs saveDb dans la même tâche : une seule transaction', async () => {
  const env = load({ idb: {} });
  await env.ready;
  const before = env.idbStats.tx;
  env.t.db.pool.url = 'X';
  env.t.saveDb(); env.t.saveDb(); env.t.saveDb();
  await env.t.store.idle();
  assert.equal(env.idbStats.tx, before + 1);
  assert.match(env.idbData.get(KEY), /"url":"X"/);
});

test('changement de compte : chaque compte garde son instantané', async () => {
  const data = new Map([[KEY, sharedText('A')], [KEY + '.u.U1', mineText('x1', 'A')]]);
  const env = load({ idb: { data } });
  await env.ready;
  assert.deepEqual(Object.keys(env.t.db.cards), ['x1']);
  env.t.setAccount('U2');
  await env.t.store.idle();
  assert.match(data.get(KEY + '.u.U1'), /"x1"/, 'U1 garde sa carte');
  assert.ok(data.has(KEY + '.u.U2'));
  assert.deepEqual(Object.keys(env.t.db.cards), []);
  assert.match(data.get(KEY), /"userId":"U2"/);
});

test('compte reconnu : l’enregistrement _ est effacé de la base', async () => {
  const env = load({ idb: {} });
  await env.ready;
  env.t.db.cards = { x1: { cardId: 'A', title: 'A', rarity: 'R', count: 1 } };
  env.t.saveDb();
  await env.t.store.idle();
  assert.ok(env.idbData.has(KEY + '.u._'));
  env.t.setAccount('U1');
  await env.t.store.idle();
  assert.ok(!env.idbData.has(KEY + '.u._'));
  assert.match(env.idbData.get(KEY + '.u.U1'), /"x1"/);
});

test('écriture qui échoue puis réussit : avertissement, puis tout est enregistré', async () => {
  let fail = false;
  const env = load({ idb: { failWrites: () => fail } });
  await env.ready;
  fail = true; // la base est ouverte et marquée ; c'est l'écriture suivante qui échoue
  env.t.db.pool.url = 'X';
  env.t.saveDb();
  await env.t.store.idle();
  assert.match(env.t.saveWarning(), /Enregistrement impossible/);
  assert.equal(env.idbData.has(KEY), false);
  fail = false;
  env.t.db.me = 'Jules';
  env.t.saveDb();
  await env.t.store.idle();
  assert.equal(env.t.saveWarning(), '');
  assert.match(env.idbData.get(KEY), /"url":"X"/);
});

test('réponse du site avant le chargement : traitée après, sans écraser ce qui est chargé', async () => {
  const data = new Map([[KEY, sharedText('A')]]);
  const g = gated();
  const auction = { id: 'A1', card_id: 'C2', base_amount: 10, effective_bid: 10, end_at: new Date(Date.now() + 36e5).toISOString(),
    snapshot_rarity: 'R', card: { wikipedia_title: 'C2', rarity: 'R' } };
  const env = load({ idb: { data, gate: g.gate }, fetch: async () => reply({ auctions: [auction] }) });
  await env.window.fetch('/api/marketplace?page=1');
  await tick();
  g.open();
  await env.ready;
  await tick();
  await env.t.store.idle();
  assert.ok(env.t.db.prices.C1, 'ce qui a été chargé est là');
  assert.ok(env.t.db.market.asks.C2, 'la réponse arrivée avant a été traitée');
  assert.match(data.get(KEY), /"C2"/);
});

// ----- Tâche 4 : plusieurs onglets -----
const until = async f => { for (let i = 0; i < 30 && !f(); i++) await tick(); };
async function twoTabs(optB = {}) {
  const data = new Map(), bus = fakeBus();
  const a = load({ idb: { data, bus } }), b = load({ idb: Object.assign({ data, bus }, optB) });
  await a.ready;
  await b.ready;
  return { a, b };
}

test('un autre onglet enregistre : celui-ci recharge', async () => {
  const { a, b } = await twoTabs();
  a.t.db.pool.url = 'X';
  a.t.saveDb();
  await a.t.store.idle();
  await until(() => b.t.db.pool.url === 'X');
  assert.equal(b.t.db.pool.url, 'X');
});

test('écritures en attente : pas de rechargement, elles seraient perdues', async () => {
  let bFails = false;
  const { a, b } = await twoTabs({ failWrites: () => bFails });
  bFails = true;
  b.t.db.pool.url = 'B';
  b.t.saveDb();
  await b.t.store.idle();
  assert.ok(b.t.store.pending.size, 'l’écriture de B attend');
  a.t.db.pool.url = 'X';
  a.t.saveDb();
  await a.t.store.idle();
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(b.t.db.pool.url, 'B');
});

test('traitement en cours : pas de rechargement', async () => {
  const { a, b } = await twoTabs();
  b.t.job.running = true;
  b.t.db.pool.url = 'B';
  a.t.db.pool.url = 'X';
  a.t.saveDb();
  await a.t.store.idle();
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(b.t.db.pool.url, 'B');
});

test('onglet occupé : les autres comptes sont quand même mis à jour, le changement de compte lit la version récente', async () => {
  const data = new Map([[KEY, sharedText('A')], [META, '{"since":1}'], [KEY + '.u.U1', mineText('x1', 'A')], [KEY + '.u.U2', mineText('x2', 'B')]]);
  const bus = fakeBus();
  const a = load({ idb: { data, bus } }), b = load({ idb: { data, bus } });
  await a.ready;
  await b.ready;
  b.t.job.running = true;
  a.t.setAccount('U2');
  a.t.db.cards.x3 = { cardId: 'C', title: 'C', rarity: 'R', count: 1 };
  a.t.saveDb();
  await a.t.store.idle();
  await until(() => /"x3"/.test(b.t.store.get(KEY + '.u.U2') || ''));
  assert.match(b.t.store.get(KEY + '.u.U2'), /"x3"/, 'B connaît la version récente de U2');
  b.t.job.running = false;
  b.t.setAccount('U2');
  assert.ok(b.t.db.cards.x3, 'au changement de compte, B lit U2 à jour');
});
