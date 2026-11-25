// Onglet Collection : le conseil « Vendre ~… » mène au formulaire de mise en vente (1.30.1). Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

test('Collection : « Vendre ~… » mène au formulaire de mise en vente, comme dans À vendre', () => {
  const { t } = load();
  const cell = t.COLS.find(c => c.k === 'adv').cell;
  const a = cell({ cardId: 'C1', price: { n: 3, med: 112 } });
  assert.equal(a.tagName, 'a');
  assert.equal(a.attrs.href, '/collection#wm-sell=C1');
  assert.equal(a.attrs.target, '_blank');
  assert.equal(cell({ cardId: 'C2', price: { n: 3, med: 1 } }).tagName, 'span', 'Défausser : pas de lien');
});
