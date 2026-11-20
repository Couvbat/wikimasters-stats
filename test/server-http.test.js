// Tests du serveur du pool : routes, clé de groupe, CORS, plafonds, limite de débit.
// Lancer : node --test test/*.test.js
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { start, VERSION } = require('../server/server');

const KEY = 'k'.repeat(24);
const ORIGIN = 'https://www.wiki-masters.com';
let server, port;

before(async () => {
  server = await start({ dbPath: ':memory:', port: 0, groupKey: KEY, allowedOrigins: [ORIGIN, 'https://wiki-masters.com'], perMinute: 1000 });
  port = server.address().port;
});
after(() => server.close());

// Requête HTTP brute : renvoie { status, headers, json }.
function req(method, path, { headers = {}, body, p = port } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: p, method, path, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (e) {} resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const auth = { 'x-group-key': KEY };

test('health répond sans clé', async () => {
  const r = await req('GET', '/v1/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, version: VERSION });
  assert.equal(VERSION, '1.4.0');
});

test('push : sans clé ou mauvaise clé, 401 ; bonne clé, 200', async () => {
  const body = { member: 'Jules', sales: [['C1', 10, '2026-11-15T10:00:00Z', 0, 1, 'A1']] };
  assert.equal((await req('POST', '/v1/push', { body })).status, 401);
  assert.equal((await req('POST', '/v1/push', { body, headers: { 'x-group-key': 'faux'.repeat(6) } })).status, 401);
  const ok = await req('POST', '/v1/push', { body, headers: auth });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.added, 1);
  const pull = await req('POST', '/v1/pull', { body: { cards: ['C1'] }, headers: auth });
  assert.deepEqual(pull.json.cards.C1.sales, [[10, '2026-11-15T10:00:00.000Z', 0, 1, 'A1', null]]);
  const known = await req('POST', '/v1/known', { body: { auctions: ['A1', 'A2'] }, headers: auth });
  assert.deepEqual(known.json.exact, { A1: ['C1', 10, '2026-11-15T10:00:00.000Z'] });
  const stats = await req('GET', '/v1/stats', { headers: auth });
  assert.equal(stats.json.sales, 1);
});

test('pré-vol CORS : origine du site acceptée, autre origine refusée', async () => {
  const pre = { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-group-key' };
  const r = await req('OPTIONS', '/v1/push', { headers: pre });
  assert.equal(r.status, 204);
  assert.equal(r.headers['access-control-allow-origin'], ORIGIN);
  assert.match(r.headers['access-control-allow-headers'], /x-group-key/);
  assert.equal(r.headers['access-control-max-age'], '600');
  assert.equal(r.headers['access-control-allow-private-network'], 'true');
  const evil = await req('OPTIONS', '/v1/push', { headers: { ...pre, origin: 'https://evil.example' } });
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
  const get = await req('GET', '/v1/health', { headers: { origin: ORIGIN } });
  assert.equal(get.headers['access-control-allow-origin'], ORIGIN);
});

test('corps trop gros, JSON invalide, listes trop longues, route inconnue', async () => {
  assert.equal((await req('POST', '/v1/push', { body: '{"x":"' + 'a'.repeat(2.1e6) + '"}', headers: auth })).status, 413);
  assert.equal((await req('POST', '/v1/push', { body: '{pas du json', headers: auth })).status, 400);
  assert.equal((await req('POST', '/v1/pull', { body: { cards: Array.from({ length: 501 }, (_, i) => 'C' + i) }, headers: auth })).status, 400);
  assert.equal((await req('POST', '/v1/known', { body: { auctions: Array.from({ length: 1001 }, (_, i) => 'A' + i) }, headers: auth })).status, 400);
  assert.equal((await req('GET', '/v1/nimporte', { headers: auth })).status, 404);
});

test('limite de débit par adresse du membre (CF-Connecting-IP)', async () => {
  const s = await start({ dbPath: ':memory:', port: 0, groupKey: KEY, allowedOrigins: [ORIGIN], perMinute: 3 });
  const p = s.address().port;
  try {
    for (let i = 0; i < 3; i++) assert.equal((await req('GET', '/v1/health', { p, headers: { 'cf-connecting-ip': '1.1.1.1' } })).status, 200);
    const r = await req('GET', '/v1/health', { p, headers: { 'cf-connecting-ip': '1.1.1.1' } });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers['retry-after']) >= 1);
    assert.equal((await req('GET', '/v1/health', { p, headers: { 'cf-connecting-ip': '2.2.2.2' } })).status, 200);
  } finally { s.close(); }
});

test('refus de démarrer avec une clé trop courte', async () => {
  await assert.rejects(() => start({ dbPath: ':memory:', port: 0, groupKey: 'court', allowedOrigins: [ORIGIN] }), /24/);
});

// ----- Profils (amis par le pool) -----
test('profils par HTTP : dépôt, lecture, retrait', async () => {
  const auth = { 'x-group-key': KEY };
  const body = { id: 'U2', pseudo: 'Paul', at: Date.now(), cards: [['C1', 'Titre', 'L', 2]], wish: [['W1', 'Souhait', 'UR']] };
  assert.equal((await req('POST', '/v1/profile', { body, headers: auth })).status, 200);
  const got = await req('GET', '/v1/profiles', { headers: auth });
  assert.equal(got.status, 200);
  const p = got.json.profiles.find(x => x.id === 'U2');
  assert.deepEqual(p.cards, [['C1', 'Titre', 'L', 2]]);
  assert.equal((await req('POST', '/v1/profile/remove', { body: { id: 'U2' }, headers: auth })).status, 200);
  assert.ok(!(await req('GET', '/v1/profiles', { headers: auth })).json.profiles.some(x => x.id === 'U2'));
});

test('profils par HTTP : sans clé 401, mal formé 400', async () => {
  assert.equal((await req('GET', '/v1/profiles')).status, 401);
  const auth = { 'x-group-key': KEY };
  const bad = { id: 'U5', pseudo: 'Zoé', at: Date.now(), cards: [['C1', 'Titre', 'zz', 1]], wish: [] };
  assert.equal((await req('POST', '/v1/profile', { body: bad, headers: auth })).status, 400);
  assert.ok(!(await req('GET', '/v1/profiles', { headers: auth })).json.profiles.some(x => x.id === 'U5'));
});

test('health : version 1.4.0', async () => {
  assert.equal((await req('GET', '/v1/health')).json.version, '1.4.0');
});

test('fil : demande la clé, rend les pages, refuse les paramètres invalides', async () => {
  assert.equal((await req('GET', '/v1/feed?since=0')).status, 401);
  await req('POST', '/v1/push', { headers: auth, body: { member: 'Jules', sales: [['C1', 30, '2026-11-15T10:00:00.000Z', 0, 1, 'A1']] } });
  const r = await req('GET', '/v1/feed?since=0', { headers: auth });
  assert.equal(r.status, 200);
  assert.equal(r.json.sales.length, 1);
  assert.equal(r.json.sales[0][1], 'C1');
  assert.match(r.json.pool, /^[0-9a-f]{16}$/);
  assert.equal(r.json.more, false);
  assert.equal((await req('GET', '/v1/feed', { headers: auth })).status, 200, 'since absent : 0');
  for (const q of ['since=-1', 'since=abc', 'since=1.5', 'since=0&limit=0', 'since=0&limit=10001', 'since=99999999999999999999'])
    assert.equal((await req('GET', '/v1/feed?' + q, { headers: auth })).status, 400, q);
});
