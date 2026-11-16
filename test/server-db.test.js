// Tests du serveur du pool : base SQLite, règles de fusion, contrôle des envois.
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, applyPush, pullCards, knownAuctions, poolStats, purgeMember } = require('../server/db');
const { parsePush } = require('../server/validate');

const now = Date.parse('2026-11-16T12:00:00Z');
const T = '2026-11-15T10:00:00.000Z', T2 = '2026-11-15T10:05:00.000Z', T3 = '2026-11-14T09:00:00.000Z';
const push = (db, body) => applyPush(db, parsePush(body, now), now);

test('insertion puis pull : relevé Pro', () => {
  const db = openDb(':memory:');
  const r = push(db, { member: 'Jules', pro: [['C1', now - 1000, [[50, '2026-11-10T00:00:00.000Z'], [40, '2026-11-09T00:00:00.000Z']]]] });
  assert.equal(r.added, 2);
  const c = pullCards(db, ['C1']).cards.C1;
  assert.deepEqual(c.pro, { at: now - 1000, by: 'Jules', sales: [[50, '2026-11-10T00:00:00.000Z', null], [40, '2026-11-09T00:00:00.000Z', null]] });
  assert.deepEqual(c.sales, []);
});

test('règle 1 : un prix provisoire devient final sur la même enchère', () => {
  const db = openDb(':memory:');
  push(db, { member: 'A', sales: [['C1', 30, T, 10, 0, 'A1']] });
  const r = push(db, { member: 'B', sales: [['C1', 45, T2, 0, 1, 'A1']] });
  assert.deepEqual(r, { added: 0, upgraded: 1, dropped: 0 });
  assert.deepEqual(pullCards(db, ['C1']).cards.C1.sales, [[45, T2, 0, 1, 'A1', null]]);
});

test('règle 2 : la même vente reçue par l’historique Pro puis comme prix exact reste une seule ligne Pro', () => {
  const db = openDb(':memory:');
  push(db, { member: 'A', pro: [['C1', now - 5000, [[60, T3]]]] });
  const r = push(db, { member: 'B', sales: [['C1', 60, T3, 0, 1, 'A2']] });
  assert.equal(r.added, 0);
  assert.equal(r.upgraded, 1);
  const c = pullCards(db, ['C1']).cards.C1;
  assert.deepEqual(c.pro.sales, [[60, T3, null]]);
  assert.deepEqual(c.sales, []);
  assert.deepEqual(knownAuctions(db, ['A2']).exact, { A2: ['C1', 60, T3] });
  assert.equal(poolStats(db).sales, 1);
});

test('un prix provisoire qui devient final sur une vente Pro déjà connue s’y fond', () => {
  const db = openDb(':memory:');
  push(db, { member: 'A', sales: [['C1', 20, T, 5, 0, 'A9']] });
  push(db, { member: 'B', pro: [['C1', now - 100, [[70, T2]]]] });
  push(db, { member: 'A', sales: [['C1', 70, T2, 0, 1, 'A9']] });
  assert.equal(poolStats(db).sales, 1);
  assert.deepEqual(knownAuctions(db, ['A9']).exact, { A9: ['C1', 70, T2] });
});

test('règle 4 : une enchère invendue retire son prix provisoire', () => {
  const db = openDb(':memory:');
  push(db, { member: 'A', sales: [['C1', 30, T, 10, 0, 'A3']] });
  const r = push(db, { member: 'A', unsold: ['A3'] });
  assert.equal(r.dropped, 1);
  assert.equal(pullCards(db, ['C1']).cards.C1, undefined);
});

test('règle 5 : le relevé Pro le plus récent gagne, une date future est ramenée à maintenant', () => {
  const db = openDb(':memory:');
  push(db, { member: 'A', pro: [['C1', now + 1e9, [[10, T]]]] });
  assert.equal(pullCards(db, ['C1']).cards.C1.pro.at, now);
  push(db, { member: 'B', pro: [['C1', now - 1e6, [[11, T2]]]] });
  const c = pullCards(db, ['C1']).cards.C1;
  assert.equal(c.pro.at, now);
  assert.equal(c.pro.by, 'A');
});

test('idempotence : le même envoi reçu deux fois n’ajoute rien', () => {
  const db = openDb(':memory:');
  const body = { member: 'A', pro: [['C1', now - 10, [[5, T]]]], sales: [['C2', 8, T2, 0, 1, 'A5'], ['C3', 9, T, 12, 0, 'A6']] };
  push(db, body);
  const before = poolStats(db).sales;
  const r = push(db, body);
  assert.equal(r.added, 0);
  assert.equal(poolStats(db).sales, before);
});

test('pull : les 20 ventes les plus récentes d’une rareté', () => {
  const db = openDb(':memory:');
  const sales = Array.from({ length: 25 }, (_, i) => ['C1', 10 + i, new Date(now - (25 - i) * 3600e3).toISOString(), 0, 1, 'X' + i]);
  push(db, { member: 'A', sales });
  const got = pullCards(db, ['C1']).cards.C1.sales;
  assert.equal(got.length, 20);
  assert.equal(got[0][0], 34);
  assert.equal(got[19][0], 15);
});

test('parsePush : plafonds, forme, entrées invalides, membre', () => {
  assert.throws(() => parsePush({ sales: Array.from({ length: 5001 }, () => ['C', 1, T, 0, 1, '']) }, now), e => e.status === 413);
  assert.throws(() => parsePush('nope', now), e => e.status === 400);
  assert.throws(() => parsePush({ sales: 'x' }, now), e => e.status === 400);
  assert.deepEqual(JSON.parse(JSON.stringify(parsePush({}, now))), { member: 'anonyme', pro: [], sales: [], unsold: [] });
  const p = parsePush({ member: '  ', sales: [['__proto__', 5, T, 0, 1, ''], ['C', -1, T, 0, 1, ''], ['C', 5, 'pas une date', 0, 1, ''], ['C', 5.5, T, 0, 1, ''], ['OK', 5, T, 0, 1, '']] }, now);
  assert.equal(p.member, 'anonyme');
  assert.equal(p.sales.length, 1);
  assert.equal(p.sales[0].card, 'OK');
});

test('purgeMember supprime les lignes du membre', () => {
  const db = openDb(':memory:');
  push(db, { member: 'Troll', sales: [['C1', 999, T, 0, 1, 'B1'], ['C2', 999, T, 0, 1, 'B2']], pro: [['C3', now, [[999, T]]]] });
  push(db, { member: 'Jules', sales: [['C1', 10, T2, 0, 1, 'B3']] });
  assert.equal(purgeMember(db, 'Troll'), 3);
  assert.equal(poolStats(db).sales, 1);
  assert.equal(pullCards(db, ['C3']).cards.C3, undefined);
});

test('rareté de chaque vente : gardée à l’envoi, rendue au pull, 20 dernières par rareté', () => {
  const db = openDb(':memory:');
  push(db, { member: 'A', pro: [['C1', now - 10, [[50, T, 'L'], [7, T2, 'UR']]]] });
  assert.deepEqual(pullCards(db, ['C1']).cards.C1.pro.sales, [[7, T2, 'UR'], [50, T, 'L']]);
  const sales = [];
  for (let i = 0; i < 25; i++) sales.push(['C2', 100 + i, new Date(now - (30 - i) * 3600e3).toISOString(), 0, 1, 'L' + i, 'L']);
  for (let i = 0; i < 3; i++) sales.push(['C2', 10 + i, new Date(now - (40 - i) * 3600e3).toISOString(), 0, 1, 'U' + i, 'UR']);
  push(db, { member: 'A', sales });
  const got = pullCards(db, ['C2']).cards.C2.sales;
  assert.equal(got.filter(s => s[5] === 'L').length, 20);
  assert.equal(got.filter(s => s[5] === 'UR').length, 3);
});

test('une vente Pro sans rareté prend celle de l’entrée', () => {
  const db = openDb(':memory:');
  push(db, { member: 'A', pro: [['C1', now - 10, [[50, T]], 'SR']] });
  assert.deepEqual(pullCards(db, ['C1']).cards.C1.pro.sales, [[50, T, 'SR']]);
});
