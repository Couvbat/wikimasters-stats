// Tests : synchronisation d'un pool local (sur ton PC) vers le pool du NAS.
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDb, applyPush, pullCards, knownAuctions, poolStats } = require('../server/db');
const { parsePush } = require('../server/validate');
const { syncOnce, syncStatus } = require('../server/sync');
const { start } = require('../server/server');

const now = Date.now();
const T = '2026-11-15T10:00:00.000Z', T2 = '2026-11-15T11:00:00.000Z', T3 = '2026-11-14T09:00:00.000Z';
const KEY = 'cle-du-nas-assez-longue-pour-passer';
const push = (db, body) => applyPush(db, parsePush(body, Date.now()), Date.now());

// Un NAS simulé : une autre base, qui applique les envois exactement comme le vrai serveur.
function fakeNas({ down = false } = {}) {
  const up = openDb(':memory:');
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, key: init.headers['x-group-key'], body: JSON.parse(init.body) });
    if (fetch.down) throw new TypeError('fetch failed');
    const res = applyPush(up, parsePush(JSON.parse(init.body), Date.now()), Date.now());
    return { ok: true, status: 200, json: async () => res };
  };
  fetch.down = down;
  return { up, calls, fetch };
}
const opts = nas => ({ url: 'https://pool.exemple.fr', key: KEY, fetch: nas.fetch });

test('tout part vers le NAS, avec le membre, la rareté et la date du relevé Pro', async () => {
  const local = openDb(':memory:');
  push(local, { member: 'Jules', pro: [['C1', now - 5000, [[50, T, 'L'], [40, T2, 'L']]]] });
  push(local, { member: 'Marie', sales: [['C2', 30, T, 0, 1, 'A1', 'SR']] });
  const nas = fakeNas();
  const r = await syncOnce(local, opts(nas));
  assert.equal(r.sent, 3);
  assert.equal(nas.calls[0].url, 'https://pool.exemple.fr/v1/push');
  assert.equal(nas.calls[0].key, KEY);
  const c1 = pullCards(nas.up, ['C1']).cards.C1;
  assert.equal(c1.pro.by, 'Jules');
  assert.equal(c1.pro.at, now - 5000);
  assert.deepEqual(c1.pro.sales.map(s => s[2]), ['L', 'L']);
  assert.deepEqual(knownAuctions(nas.up, ['A1']).exact, { A1: ['C2', 30, T] });
  assert.equal(poolStats(nas.up).members, 2);
});

test('une deuxième synchronisation n’envoie que ce qui est nouveau ou modifié', async () => {
  const local = openDb(':memory:');
  push(local, { member: 'Jules', sales: [['C1', 10, T, 0, 1, 'A1', 'R'], ['C2', 20, T, 8, 0, 'A9', 'R']] });
  const nas = fakeNas();
  await syncOnce(local, opts(nas));
  const n = nas.calls.length;
  assert.equal((await syncOnce(local, opts(nas))).sent, 0);
  assert.equal(nas.calls.length, n, 'rien de nouveau : aucun envoi');
  await new Promise(r => setTimeout(r, 5));
  push(local, { member: 'Jules', sales: [['C3', 5, T2, 0, 1, 'A3', 'C']] });
  push(local, { member: 'Jules', sales: [['C2', 25, T2, 0, 1, 'A9', 'R']] }); // le provisoire devient final
  const r = await syncOnce(local, opts(nas));
  assert.equal(r.sent, 2);
  assert.deepEqual(knownAuctions(nas.up, ['A9']).exact, { A9: ['C2', 25, T2] });
});

test('une enchère finie sans vente retire aussi le prix provisoire du NAS', async () => {
  const local = openDb(':memory:');
  push(local, { member: 'Jules', sales: [['C1', 30, T, 10, 0, 'A5', 'SR']] });
  const nas = fakeNas();
  await syncOnce(local, opts(nas));
  assert.equal(poolStats(nas.up).sales, 1);
  push(local, { member: 'Jules', unsold: ['A5'] });
  const r = await syncOnce(local, opts(nas));
  assert.equal(r.unsold, 1);
  assert.equal(poolStats(nas.up).sales, 0);
});

test('NAS injoignable : rien n’est perdu, tout repart au passage suivant', async () => {
  const local = openDb(':memory:');
  push(local, { member: 'Jules', sales: [['C1', 10, T, 0, 1, 'A1', 'R']], unsold: ['Z1'] });
  const nas = fakeNas({ down: true });
  await assert.rejects(() => syncOnce(local, opts(nas)), /fetch failed/);
  assert.match(syncStatus(local).err, /fetch failed/);
  nas.fetch.down = false;
  const r = await syncOnce(local, opts(nas));
  assert.equal(r.sent, 1);
  assert.equal(r.unsold, 1);
  assert.equal(syncStatus(local).err, '');
  assert.ok(syncStatus(local).at > 0);
});

test('gros volume : envoi par lots qui respectent les plafonds du serveur', async () => {
  const local = openDb(':memory:');
  const sales = Array.from({ length: 3500 }, (_, i) => ['C' + i, 10 + i, new Date(now - i * 60000).toISOString(), 0, 1, 'A' + i, 'R']);
  push(local, { member: 'Jules', sales: sales.slice(0, 3000) });
  push(local, { member: 'Jules', sales: sales.slice(3000) });
  const pro = Array.from({ length: 1700 }, (_, i) => ['P' + i, now - 1000, [[5, T3, 'C']]]);
  push(local, { member: 'Marie', pro });
  const nas = fakeNas();
  const r = await syncOnce(local, opts(nas));
  assert.equal(r.sent, 3500 + 1700);
  assert.equal(poolStats(nas.up).sales, 3500 + 1700);
  for (const c of nas.calls) {
    assert.ok((c.body.sales || []).length <= 5000 && (c.body.pro || []).length <= 2000);
    assert.ok(JSON.stringify(c.body).length < 2 * 1024 * 1024);
  }
});

// Le vrai serveur, lancé en mode relais vers un second vrai serveur.
function req(port, method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('serveur local en mode relais : ce qu’il reçoit arrive tout seul sur le NAS', async () => {
  const LOCAL = 'cle-du-pool-local-assez-longue';
  const nasSrv = await start({ dbPath: ':memory:', port: 0, groupKey: KEY, allowedOrigins: [] });
  const nasPort = nasSrv.address().port;
  const localSrv = await start({ dbPath: ':memory:', port: 0, groupKey: LOCAL, allowedOrigins: [],
    upstream: { url: 'http://127.0.0.1:' + nasPort, key: KEY, everyMs: 100 } });
  const localPort = localSrv.address().port;
  try {
    const r = await req(localPort, 'POST', '/v1/push', { member: 'Jules', sales: [['C1', 42, T, 0, 1, 'A1', 'UR']] }, { 'x-group-key': LOCAL });
    assert.equal(r.status, 200);
    let stats;
    for (let i = 0; i < 40; i++) {
      await new Promise(res => setTimeout(res, 100));
      stats = (await req(nasPort, 'GET', '/v1/stats', null, { 'x-group-key': KEY })).json;
      if (stats.sales) break;
    }
    assert.equal(stats.sales, 1);
    const health = (await req(localPort, 'GET', '/v1/health')).json;
    assert.ok(health.upstream && health.upstream.at > 0 && health.upstream.err === '');
  } finally {
    localSrv.close();
    nasSrv.close();
  }
});
