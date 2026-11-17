// Tests : données rangées dans IndexedDB (sans la limite de 5 Mo du localStorage), migration vérifiée, mode secours.
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

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
