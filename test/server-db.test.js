// Tests du serveur du pool : base SQLite, règles de fusion, contrôle des envois.
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { openDb, applyPush, pullCards, knownAuctions, poolStats, purgeMember, putProfile, listProfiles, removeProfile, feedRows, getMeta } = require('../server/db');
const { parsePush, parseProfile } = require('../server/validate');

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

test('pull : toutes les ventes d’une rareté (plus de 20)', () => {
  const db = openDb(':memory:');
  const at = i => new Date(now - (i + 1) * 3600e3).toISOString();
  const pro = Array.from({ length: 75 }, (_, i) => [100 + i, at(i), 'L']);
  const sales = Array.from({ length: 75 }, (_, i) => ['C1', 10 + i, at(200 + i), 0, 1, 'X' + i, 'L']);
  push(db, { member: 'A', pro: [['C1', now - 10, pro]], sales });
  const c = pullCards(db, ['C1']).cards.C1;
  assert.equal(c.pro.sales.length, 75);
  assert.equal(c.sales.length, 75);
  assert.equal(c.pro.sales[0][0], 100, 'la plus récente d’abord');
});

test('pull : 2 000 au plus, les plus récentes', () => {
  const db = openDb(':memory:');
  const all = Array.from({ length: 2500 }, (_, i) => [1 + i, new Date(now - (i + 1) * 60e3).toISOString(), 'C']);
  const pro = [];
  for (let i = 0; i < all.length; i += 200) pro.push(['C1', now - 10, all.slice(i, i + 200)]);
  push(db, { member: 'A', pro });
  const got = pullCards(db, ['C1']).cards.C1.pro.sales;
  assert.equal(got.length, 2000);
  assert.equal(got[0][0], 1);
  assert.equal(got[1999][0], 2000);
});

test('push : jusqu’à 200 ventes par relevé Pro', () => {
  const sales = Array.from({ length: 250 }, (_, i) => [1 + i, new Date(now - (i + 1) * 60e3).toISOString(), 'L']);
  const p = parsePush({ pro: [['C1', now - 10, sales]] }, now);
  assert.equal(p.pro[0].sales.length, 200);
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

test('rareté de chaque vente : gardée à l’envoi, rendue au pull, toutes les ventes de chaque rareté', () => {
  const db = openDb(':memory:');
  push(db, { member: 'A', pro: [['C1', now - 10, [[50, T, 'L'], [7, T2, 'UR']]]] });
  assert.deepEqual(pullCards(db, ['C1']).cards.C1.pro.sales, [[7, T2, 'UR'], [50, T, 'L']]);
  const sales = [];
  for (let i = 0; i < 25; i++) sales.push(['C2', 100 + i, new Date(now - (30 - i) * 3600e3).toISOString(), 0, 1, 'L' + i, 'L']);
  for (let i = 0; i < 3; i++) sales.push(['C2', 10 + i, new Date(now - (40 - i) * 3600e3).toISOString(), 0, 1, 'U' + i, 'UR']);
  push(db, { member: 'A', sales });
  const got = pullCards(db, ['C2']).cards.C2.sales;
  assert.equal(got.filter(s => s[5] === 'L').length, 25);
  assert.equal(got.filter(s => s[5] === 'UR').length, 3);
});

test('une vente Pro sans rareté prend celle de l’entrée', () => {
  const db = openDb(':memory:');
  push(db, { member: 'A', pro: [['C1', now - 10, [[50, T]], 'SR']] });
  assert.deepEqual(pullCards(db, ['C1']).cards.C1.pro.sales, [[50, T, 'SR']]);
});

// ----- Profils (amis par le pool) -----
const prof = (id, pseudo, cards = [['C1', 'Titre', 'L', 2]], wish = [['W1', 'Souhait', 'UR']]) => ({ id, pseudo, at: now - 1000, cards, wish });

test('profils : dépôt, lecture, remplacement, retrait', () => {
  const db = openDb(':memory:');
  putProfile(db, parseProfile(prof('U2', 'Paul')), now);
  putProfile(db, parseProfile(prof('U3', 'Marie')), now);
  assert.equal(listProfiles(db).profiles.length, 2);
  putProfile(db, parseProfile(prof('U2', 'Paulo', [['C9', 'Autre', 'R', 1]])), now);
  const p2 = listProfiles(db).profiles.find(p => p.id === 'U2');
  assert.equal(p2.pseudo, 'Paulo');
  assert.deepEqual(p2.cards, [['C9', 'Autre', 'R', 1]]);
  assert.deepEqual(p2.wish, [['W1', 'Souhait', 'UR']]);
  assert.equal(removeProfile(db, 'U2'), true);
  assert.equal(listProfiles(db).profiles.length, 1);
  assert.equal(removeProfile(db, 'U2'), false);
});

test('purge retire aussi le profil du membre, et stats compte les profils', () => {
  const db = openDb(':memory:');
  putProfile(db, parseProfile(prof('U2', 'Paul')), now);
  assert.equal(poolStats(db).profiles, 1);
  purgeMember(db, 'Paul');
  assert.equal(listProfiles(db).profiles.length, 0);
  assert.equal(poolStats(db).profiles, 0);
});

test('parseProfile refuse ce qui ne va pas', () => {
  const status = body => { try { parseProfile(body); return 200; } catch (e) { return e.status; } };
  assert.equal(status(prof('U2', 'Paul')), 200);
  assert.equal(status(prof('U2', 'Paul', Array.from({ length: 20001 }, (_, i) => ['C' + i, 'T', 'C', 1]))), 413);
  assert.equal(status(prof('U2', 'Paul', [['C1', 'T', 'zz', 1]])), 400);
  assert.equal(status(prof('U2', 'Paul', [['C1', 'T', 'L', 0]])), 400);
  assert.equal(status(prof('U2', '')), 400);
  assert.equal(status(prof('__proto__', 'Paul')), 400);
});

// ----- Fil des nouveautés (pool 1.4.0) -----
test('fil : tout, dans l’ordre des numéros, page par page, sans trou ni doublon', () => {
  const db = openDb(':memory:');
  push(db, { member: 'Jules', pro: [['C1', now - 1000, [[50, T], [40, T3]]]] }); // rev 1, 2 (ventes), 3 (relevé)
  push(db, { member: 'Paul', sales: [['C2', 30, T, 10, 0, 'A1', 'SR']], unsold: ['A9'] }); // rev 4 (vente), 5 (unsold)
  const p1 = feedRows(db, 0, 3);
  assert.equal(p1.more, true);
  assert.equal(p1.next, 3);
  assert.equal(p1.max, 5);
  assert.deepEqual(p1.sales.map(r => r[0]), [1, 2]);
  assert.deepEqual(p1.pro, [[3, 'C1', now - 1000, 'Jules']]);
  const p2 = feedRows(db, p1.next, 3);
  assert.equal(p2.more, false);
  assert.equal(p2.next, 5);
  assert.deepEqual(p2.sales, [[4, 'C2', 30, T, 'prov', 'A1', 10, 'SR']]);
  assert.deepEqual(p2.unsold, [[5, 'A9']]);
  assert.deepEqual(feedRows(db, 5, 3), { pool: p1.pool, max: 5, next: 5, more: false, sales: [], pro: [], unsold: [] });
});

test('fil : un provisoire devenu final revient avec un numéro plus grand', () => {
  const db = openDb(':memory:');
  push(db, { member: 'A', sales: [['C1', 30, T, 10, 0, 'A1']] });
  const before = feedRows(db, 0, 100);
  push(db, { member: 'B', sales: [['C1', 45, T2, 0, 1, 'A1']] });
  const after = feedRows(db, before.next, 100);
  assert.equal(after.sales.length, 1);
  assert.equal(after.sales[0][4], 'exact');
  assert.equal(after.sales[0][2], 45);
  assert.ok(after.sales[0][0] > before.next);
});

test('fil : l’identifiant du pool est créé une fois et survit à la réouverture', () => {
  const file = path.join(os.tmpdir(), 'wm-feed-' + process.pid + '.db');
  const a = openDb(file);
  const id = getMeta(a, 'pool_id');
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(feedRows(a, 0, 10).pool, id);
  a.close();
  const b = openDb(file);
  assert.equal(getMeta(b, 'pool_id'), id);
  b.close();
  for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(f, { force: true });
});

test('fil : une vente Pro porte la date et l’auteur du relevé de sa carte', () => {
  const db = openDb(':memory:');
  push(db, { member: 'Jules', pro: [['C1', now - 1000, [[50, T]]]] });
  push(db, { member: 'Paul', sales: [['C1', 50, T, 0, 1, 'A1']] }); // l'enchère s'accroche à la ligne Pro : nouveau numéro
  const rows = feedRows(db, 0, 10);
  assert.deepEqual(rows.pro, [[2, 'C1', now - 1000, 'Jules']]);
  assert.deepEqual(rows.sales, [[3, 'C1', 50, T, 'pro', 'A1', 0, null, now - 1000, 'Jules']]);
});
