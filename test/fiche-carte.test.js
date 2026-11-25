// Tests de la fiche par carte (1.29.0). Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');
const DAY = 864e5, NOW = Date.now();
const iso = d => new Date(NOW - d * DAY).toISOString();
const sale = (d, p, r = 'SR', more = {}) => Object.assign({ p, t: iso(d), r }, more);
const nb = s => String(s).replace(/[  ]/g, ' ');
const textOf = n => (n == null || n === false ? '' : Array.isArray(n) ? n.map(textOf).join(' ')
  : typeof n === 'object' ? (n.textContent || '') + ' ' + (n.children || []).map(textOf).join(' ') : String(n));
const find = (n, pred, out = []) => {
  if (Array.isArray(n)) { for (const k of n) find(k, pred, out); return out; }
  if (n && typeof n === 'object') { if (pred(n)) out.push(n); for (const k of n.children || []) find(k, pred, out); }
  return out;
};

// ----- Tâche 1 : la source des ventes -----
test('source de la fiche : celle de priceOf, avec toutes ses ventes (l’historique Pro passe devant les prix observés)', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: Array.from({ length: 12 }, (_, i) => sale(i * 5, 100 + i)) };
  t.db.obsSales.C1 = [sale(1, 50, 'SR', { x: 1, i: 'A1' }), sale(2, 55, 'SR', { x: 1, i: 'A2' })];
  const src = t.cardSource('C1', 'SR');
  assert.equal(src.kind, 'pro');
  assert.equal(src.sales.length, 12);
  assert.equal(t.priceOf('C1', 'SR').nAll, 12, 'priceOf repose sur la même source');
});

test('source de la fiche : tes ventes sans historique Pro, sinon les prix observés', () => {
  const { t } = load();
  t.db.obsSales.C1 = [sale(1, 50, 'SR', { x: 1, i: 'A1' })];
  assert.equal(t.cardSource('C1', 'SR').kind, 'obs');
  t.db.mySales.C1 = [sale(3, 70)];
  assert.equal(t.cardSource('C1', 'SR').kind, 'own');
});

test('source de la fiche : aucune vente à la rareté voulue, pas de mélange ; les raretés qui ont des ventes', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 900, 'UR'), sale(2, 950, 'L')] };
  assert.deepEqual(plain(t.cardSource('C1', 'SR')), { kind: null, sales: [] });
  assert.equal(t.priceOf('C1', 'SR').mixed, true, 'priceOf, lui, se rabat sur les autres raretés');
  assert.deepEqual(plain(t.cardRarities('C1')), ['L', 'UR']);
});

// ----- Tâche 2 : les repères -----
const base5 = p => [10, 12, 14, 16, 18].map(d => sale(d, p));
// Prix qui évolue de `weekly` par semaine : 1000 ₩ aujourd'hui, n ventes espacées de 3,5 jours à partir d'hier.
const trend = (weekly, n = 8) => Array.from({ length: n }, (_, i) => { const d = 1 + i * 3.5; return sale(d, Math.round(1000 * Math.pow(1 + weekly, -d / 7))); });

test('repère 1 : plus cher, moins cher, dans son habitude', () => {
  const { t } = load();
  const m = sales => t.cardCues(sales, NOW, null).moment;
  let c = m([sale(1, 130), sale(2, 130), sale(3, 130), ...base5(100)]);
  assert.equal(c.state, 'high'); assert.equal(c.pct, 30);
  c = m([sale(1, 80), sale(2, 80), sale(3, 80), ...base5(100)]);
  assert.equal(c.state, 'low'); assert.equal(c.pct, -20);
  assert.equal(m([sale(1, 105), sale(2, 105), sale(3, 105), ...base5(100)]).state, 'usual');
  const line = nb(t.cueLines(t.cardCues([sale(1, 80), sale(2, 80), sale(3, 80), ...base5(100)], NOW, null))[0].text);
  assert.match(line, /^moins cher que d’habitude \(−20 %\) · 7 derniers jours : 80 ₩ \(3 ventes\), 30 jours d’avant : 100 ₩ \(5 ventes\)$/);
});

test('repère 1 : pas assez de ventes pour comparer', () => {
  const { t } = load();
  const m = sales => t.cardCues(sales, NOW, null).moment.state;
  assert.equal(m([sale(1, 130), sale(2, 130), ...base5(100)]), 'few', '2 ventes sur 7 jours');
  assert.equal(m([sale(1, 130), sale(2, 130), sale(3, 130), ...base5(100).slice(0, 4)]), 'few', '4 ventes sur les 30 jours d’avant');
  assert.equal(nb(t.cueLines(t.cardCues([sale(1, 130)], NOW, null))[0].text), 'pas assez de ventes pour comparer');
});

test('repère 2 : en hausse, en baisse, stable', () => {
  const { t } = load();
  const s = sales => t.cardCues(sales, NOW, null).slope;
  let c = s(trend(0.10));
  assert.equal(c.state, 'up'); assert.ok(c.pct >= 9 && c.pct <= 11, String(c.pct));
  c = s(trend(-0.10));
  assert.equal(c.state, 'down'); assert.ok(c.pct <= -9 && c.pct >= -11, String(c.pct));
  assert.equal(s(trend(0.01)).state, 'flat');
  assert.equal(nb(t.cueLines(t.cardCues(trend(-0.10), NOW, null))[1].text), 'en baisse (−10 % par semaine)');
});

test('repère 2 : une vente aberrante ne renverse pas le sens ; moins de 6 ventes, pas de sens', () => {
  const { t } = load();
  const s = sales => t.cardCues(sales, NOW, null).slope.state;
  assert.equal(s([sale(0.5, 50000), ...trend(-0.10)]), 'down');
  assert.equal(s(trend(0.10, 5)), 'few');
});

test('repère 3 : environ N fois par semaine, par mois, ou aucune vente en 30 jours', () => {
  const { t } = load();
  const pace = sales => nb(t.cueLines(t.cardCues(sales, NOW, null))[2].text);
  assert.equal(pace(Array.from({ length: 9 }, (_, i) => sale(1 + i * 3, 100))), 'se vend environ 2 fois par semaine · dernière vente il y a 1 j');
  assert.match(pace([sale(2, 100), sale(9, 100), sale(20, 100)]), /^se vend environ 3 fois par mois · /);
  assert.equal(pace([sale(40, 100), sale(45, 100)]), 'aucune vente en 30 jours · dernière vente il y a 40 j');
});

test('repère 4 : la concurrence à la bonne rareté seulement, avec l’âge du relevé', () => {
  const { t } = load();
  const list = [{ a: 120, b: false, r: 'SR', i: 'A1' }, { a: 50, b: true, r: 'UR', i: 'A2' }, { a: 150, b: false, r: 'SR', i: 'A3' }];
  const line = asks => nb(t.cueLines(t.cardCues([sale(1, 100)], NOW, asks)).find(l => l.k === 'compete').text);
  assert.equal(line({ list, rarity: 'SR', seenAt: NOW - 2 * 36e5 }), '2 en vente, la moins chère à 120 ₩ · relevé il y a 2 h');
  assert.equal(line({ list: list.slice(1, 2), rarity: 'SR', seenAt: NOW - 3 * 36e5 }), 'aucune annonce connue à cette rareté (relevé il y a 3 h)');
  assert.equal(line({ list: [], rarity: 'SR', seenAt: 0 }), 'annonces jamais cherchées');
  assert.equal(t.cueLines(t.cardCues([sale(1, 100)], NOW, null)).some(l => l.k === 'compete'), false);
});

test('repères en court pour la bulle', () => {
  const { t } = load();
  assert.equal(nb(t.cueShort(t.cardCues([sale(1, 130), sale(2, 130), sale(3, 130), ...base5(100)], NOW, null))), 'plus cher que d’habitude · en hausse');
  assert.equal(t.cueShort(t.cardCues([sale(1, 100)], NOW, null)), '');
});

test('repères : date illisible ignorée, date future comptée comme maintenant, ventes à la même date', () => {
  const { t } = load();
  const odd = [{ p: 100, t: 'n/a', r: 'SR' }, sale(-2, 130), sale(1, 130), sale(2, 130), ...base5(100)];
  const c = t.cardCues(odd, NOW, null);
  assert.equal(c.moment.n7, 3);
  assert.equal(c.moment.state, 'high');
  const same = Array.from({ length: 8 }, () => sale(3, 100));
  assert.equal(t.cardCues(same, NOW, null).slope.state, 'few', 'aucune paire de dates différentes');
  for (const s of [odd, same]) assert.doesNotMatch(t.cueLines(t.cardCues(s, NOW, null)).map(l => l.text).join(' '), /NaN|undefined|Infinity/);
});

// ----- Tâche 3 : la fiche dans le panneau -----
// Faux éléments de la fiche ; renvoie une fonction qui lit tout son texte.
function fiche(t) {
  const out = {};
  for (const k of ['cardHead', 'cardBody']) t.ui.el[k] = { replaceChildren(...kids) { out[k] = kids; } };
  t.ui.el.cardStatus = { textContent: '' };
  return Object.assign(() => nb(textOf([out.cardHead, out.cardBody])), { out });
}

test('fiche : repères, ce que la carte t’a coûté et ce que la vendre rapporterait', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 120), sale(2, 120), sale(3, 120), ...base5(100)] };
  t.db.cards.X1 = { cardId: 'C1', title: 'Paris', rarity: 'SR', count: 1, shiny: false };
  t.db.auctions.B1 = ['b', 'C1', 'Paris', 'SR', 50, 80, 80, iso(20), 0];
  const text = fiche(t);
  t.openCard('C1');
  t.renderCard();
  const s = text();
  assert.match(s, /Paris/);
  assert.match(s, /Prix du moment/);
  assert.match(s, /plus cher que d’habitude \(\+20 %\)/);
  assert.match(s, /achetée 80 ₩/);
  assert.match(s, /\+40 ₩/);
  assert.doesNotMatch(s, /\b(vends|achète)\b/i);
});

test('fiche ouverte depuis une annonce : écart à la valeur, bonne affaire et enchère max', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 120), sale(2, 120), sale(3, 120)] };
  const text = fiche(t);
  t.openCard('C1', { rarity: 'SR', au: { a: 70, b: false, r: 'SR', i: 'A1' }, title: 'Paris' });
  t.renderCard();
  const s = text();
  assert.match(s, /Face à l’annonce/);
  assert.match(s, /42 % sous la valeur/);
  assert.match(s, /bonne affaire −42 %/);
  assert.match(s, /enchère max conseillée : 120 ₩/);
});

test('fiche : aucune vente à cette rareté, pas de mélange, et les raretés qui en ont', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 900, 'UR'), sale(2, 950, 'UR')] };
  const text = fiche(t);
  t.openCard('C1', { rarity: 'SR', title: 'Paris' });
  t.renderCard();
  const s = text();
  assert.match(s, /Aucune vente connue à cette rareté/);
  assert.match(s, /Ventes connues en : .*UR/);
  assert.doesNotMatch(s, /\b(900|950)\b/, 'aucune vente UR listée comme vente SR');
});

test('fiche : les 50 ventes les plus récentes, puis toutes', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: Array.from({ length: 80 }, (_, i) => sale(i * 0.5, 100 + i)) };
  const text = fiche(t);
  t.openCard('C1', { rarity: 'SR', title: 'Paris' });
  t.renderCard();
  const rows = () => find(text.out.cardBody, n => n.tagName === 'tbody').reduce((a, b) => a + b.children.length, 0);
  assert.equal(rows(), 50);
  assert.match(text(), /Tout afficher \(80\)/);
  t.ui.card.all = true;
  t.renderCard();
  assert.equal(rows(), 80);
});

test('fiche : ← Retour et un onglet ramènent à l’onglet d’origine, fermer le panneau ferme la fiche', () => {
  const { t } = load();
  t.ui.el.back = { classList: { toggle() {} } };
  t.ui.tab = 'wish';
  t.openCard('C1', { title: 'Paris' });
  assert.equal(t.ui.card.from, 'wish');
  t.closeCard();
  assert.equal(t.ui.card, null);
  assert.equal(t.ui.tab, 'wish');
  t.openCard('C1', { title: 'Paris' });
  t.setTab('col');
  assert.equal(t.ui.card, null);
  assert.equal(t.ui.tab, 'col');
  t.openCard('C1', { title: 'Paris' });
  t.ui.open = true;
  t.toggle(false);
  assert.equal(t.ui.card, null);
});

test('fiche : actions grisées pendant un autre traitement, et recherche impossible sans le nom', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 120)] };
  fiche(t);
  t.openCard('C1', { rarity: 'SR', title: 'Paris' });
  t.job.running = true;
  t.renderCard();
  assert.equal(t.ui.el.cardSearch.disabled, true);
  t.job.running = false;
  t.syncButtons();
  assert.equal(t.ui.el.cardSearch.disabled, false);
  t.openCard('C9', { rarity: 'SR' });
  t.renderCard();
  assert.equal(t.ui.el.cardSearch.disabled, true, 'nom inconnu : la recherche par nom est impossible');
});

test('fiche d’une carte inconnue partout : aucune vente, pas de plantage', () => {
  const { t } = load();
  const text = fiche(t);
  t.openCard('C404');
  t.renderCard();
  assert.match(text(), /Aucune vente connue/);
  assert.doesNotMatch(text(), /NaN|undefined|Infinity/);
});

// ----- Tâche 4 : la courbe -----
test('courbe : axe des prix borné aux 2e et 98e centiles, sauf avec peu de ventes', () => {
  const { t } = load();
  const [lo, hi] = t.chartBounds(Array.from({ length: 49 }, (_, i) => 100 + i).concat([10000]));
  assert.ok(lo >= 100 && lo < 102, String(lo));
  assert.ok(hi >= 148 && hi < 1000, 'la vente aberrante ne fixe pas le haut de l’axe : ' + hi);
  assert.deepEqual(plain(t.chartBounds([10, 1000, 500])), [10, 1000]);
  assert.deepEqual(plain(t.chartBounds([100, 100, 100])), [99, 101]);
});

test('courbe : 30 jours par défaut, tout s’il y a moins de 10 ventes en 30 jours', () => {
  const { t } = load();
  assert.equal(t.defaultPeriod(Array.from({ length: 10 }, (_, i) => sale(i, 100)), NOW), '30');
  assert.equal(t.defaultPeriod(Array.from({ length: 9 }, (_, i) => sale(i, 100)).concat([sale(60, 100)]), NOW), 'all');
});

test('courbe : tes ventes et achats à la rareté affichée, sans les shiny ni les invendues', () => {
  const { t } = load();
  t.db.auctions = {
    S1: ['s', 'C1', 'Paris', 'SR', 50, 50, 130, iso(3), 0],
    B1: ['b', 'C1', 'Paris', 'SR', 50, 50, 90, iso(9), 0],
    B2: ['b', 'C1', 'Paris', 'UR', 50, 50, 900, iso(5), 0],
    B3: ['b', 'C1', 'Paris', 'SR', 50, 50, 400, iso(4), 1],
    U1: ['u', 'C1', 'Paris', 'SR', 50, 50, null, iso(2), 0]
  };
  assert.deepEqual(plain(t.cardMarks('C1', 'SR')).map(m => [m.k, m.p]), [['b', 90], ['s', 130]]);
});

test('courbe : point creux pour un provisoire, segments des deux médianes, détail au survol', () => {
  const { t } = load();
  const pts = [{ t: NOW - DAY, p: 120, k: 'pro' }, { t: NOW - 2 * DAY, p: 110, k: 'prov' }, { t: NOW - 12 * DAY, p: 100, k: 'exact' }];
  const svg = t.cardChart(pts, [{ t: NOW - 3 * DAY, p: 115, k: 's' }], '30', NOW, { med7: 115, medBase: 100 });
  const circles = find(svg, n => n.tagName === 'circle');
  assert.equal(circles.length, 3);
  assert.equal(circles.filter(c => c.attrs.fill === 'none').length, 1, 'le provisoire est creux');
  assert.equal(find(svg, n => n.tagName === 'line' && n.attrs['stroke-dasharray']).length, 1, 'médiane des 30 jours d’avant en pointillés');
  assert.equal(find(svg, n => n.tagName === 'path').length, 1, 'ta vente en losange');
  assert.match(nb(textOf(svg)), /provisoire/);
  assert.match(nb(textOf(svg)), /ta vente/);
});

test('courbe : ventes toutes au même prix, l’axe ne s’écrase pas', () => {
  const { t } = load();
  const svg = t.cardChart([1, 2, 3].map(d => ({ t: NOW - d * DAY, p: 100, k: 'pro' })), [], '30', NOW, { med7: null, medBase: null });
  for (const c of find(svg, n => n.tagName === 'circle')) assert.ok(Number.isFinite(Number(c.attrs.cy)), c.attrs.cy);
});

// ----- Tâche 5 : pastilles et bulle -----
test('bulle : les repères en court, et le clic vers la fiche', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 130), sale(2, 130), sale(3, 130), ...base5(100)] };
  const lines = t.badgeFor('C1', null, {}).lines.map(nb);
  assert.ok(lines.includes('Repères : plus cher que d’habitude · en hausse'), lines.join('\n'));
  assert.equal(lines[lines.length - 1], 'Clic : fiche de la carte');
});

test('bulle : sans assez de ventes, pas de ligne de repères', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 130), sale(2, 120)] };
  const lines = t.badgeFor('C1', null, {}).lines;
  assert.ok(!lines.some(l => l.startsWith('Repères')));
  assert.ok(lines.includes('Clic : fiche de la carte'));
});

test('bulle : de nouvelles ventes changent les repères sans attendre', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 100), sale(2, 100), sale(3, 100), ...base5(100)] };
  assert.ok(t.badgeFor('C1', null, {}).lines.map(nb).includes('Repères : dans son habitude · stable'));
  t.mergePro([['C1', NOW, [[150, iso(0.5), 'SR'], [150, iso(0.6), 'SR'], [150, iso(0.7), 'SR'], [150, iso(0.8), 'SR']]]]);
  assert.ok(t.badgeFor('C1', null, {}).lines.map(nb).some(l => /^Repères : plus cher que d’habitude/.test(l)));
});

test('clic sur une pastille : la fiche s’ouvre à la rareté de l’annonce, sans suivre le lien du site', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 120, 'UR'), sale(2, 100, 'SR')] };
  t.db.cards.X1 = { cardId: 'C1', title: 'Paris', rarity: 'SR', count: 1, shiny: false };
  t.ui.tab = 'col';
  const b = t.badgeFor('C1', { a: 90, b: false, r: 'UR', i: 'A1' }, {});
  assert.equal(b.card.id, 'C1');
  b.card.title = 'Paris';
  const el = {};
  t.tipData.set(el, b);
  const calls = [];
  t.badgeClick({ target: { closest: () => el }, preventDefault: () => calls.push('prevent'), stopPropagation: () => calls.push('stop') });
  assert.deepEqual(calls, ['prevent', 'stop']);
  assert.equal(t.ui.card.id, 'C1');
  assert.equal(t.ui.card.rarity, 'UR', 'la rareté de l’annonce, comme la pastille');
  assert.equal(t.ui.card.au.a, 90);
  assert.equal(t.ui.card.from, 'col');
});

test('clic ailleurs sur la page : rien n’est intercepté', () => {
  const { t } = load();
  const calls = [];
  t.badgeClick({ target: { closest: () => null }, preventDefault: () => calls.push('prevent'), stopPropagation: () => calls.push('stop') });
  assert.deepEqual(calls, []);
  assert.equal(t.ui.card, null);
});

// ----- Relecture finale -----
test('repère 2 : des ventes groupées en quelques heures ou jours ne donnent pas de sens', () => {
  const { t } = load();
  const s = sales => t.cardCues(sales, NOW, null).slope;
  const h = (hours, p) => ({ p, t: new Date(NOW - DAY - hours * 36e5).toISOString(), r: 'SR' });
  assert.equal(s([0, 0.5, 1, 1.5, 2, 3].map((x, i) => h(x, 130 - i * 6))).state, 'few', '6 ventes en 3 heures');
  assert.equal(s([0, 0.003, 0.006, 0.009, 0.012, 0.015].map((x, i) => h(x, 2000 / Math.pow(2, i)))).state, 'few', '6 ventes en une minute');
  assert.equal(s(Array.from({ length: 8 }, (_, i) => sale(0.25 * i, 1000 - i * 60))).state, 'few', '8 ventes en 2 jours');
  const c = s([...[0, 0.5, 1, 1.5, 2, 3].map((x, i) => h(x, 130 - i * 6)), sale(10, 100), sale(20, 100)]);
  assert.ok(Number.isFinite(c.pct) && Math.abs(c.pct) < 100, String(c.pct));
  assert.doesNotMatch(t.cueLines(t.cardCues([0, 0.003, 0.006, 0.009, 0.012, 0.015].map((x, i) => h(x, 2000 / Math.pow(2, i))), NOW, null)).map(l => l.text).join(' '), /Infinity|NaN/);
});

test('clic sur une pastille sans annonce : la fiche s’ouvre à la rareté de la pastille', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 100, 'SR'), sale(2, 900, 'UR')] };
  t.db.cards = { a: { cardId: 'C1', title: 'Paris', rarity: 'SR', count: 1, shiny: false }, b: { cardId: 'C1', title: 'Paris', rarity: 'UR', count: 1, shiny: false } };
  const b = t.badgeFor('C1', null, {});
  const el = {};
  t.tipData.set(el, b);
  t.badgeClick({ target: { closest: () => el }, preventDefault() {}, stopPropagation() {} });
  assert.equal(t.ui.card.rarity, t.rarityOf('C1'), 'la rareté que la pastille a évaluée');
  assert.equal(t.ui.card.rarity, 'UR');
});

test('repères : 20 cartes à 300 ventes se calculent sans geler la page', () => {
  const { t } = load();
  const sales = Array.from({ length: 300 }, (_, i) => ({ p: 100 + (i * 37) % 50, t: new Date(NOW - (i / 10) * DAY - 36e5).toISOString(), r: 'SR' }));
  t.cardCues(sales, NOW, null);
  const t0 = performance.now();
  for (let k = 0; k < 20; k++) t.cardCues(sales, NOW, null);
  const ms = performance.now() - t0;
  assert.ok(ms < 150, Math.round(ms) + ' ms');
});

// ----- Relecture Copilot -----
test('fiche : seulement des nœuds ou du texte passés à replaceChildren, comme le DOM réel le demande', () => {
  const { t } = load();
  const bad = [];
  const strict = name => ({ replaceChildren(...kids) {
    kids.forEach((k, i) => { if (!(typeof k === 'string' || (k && typeof k === 'object' && k.nodeType))) bad.push(name + '[' + i + '] = ' + (Array.isArray(k) ? 'tableau' : String(k))); });
  } });
  t.ui.el.cardHead = strict('cardHead');
  t.ui.el.cardBody = strict('cardBody');
  t.ui.el.cardStatus = { textContent: '' };
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 120, 'SR'), sale(2, 900, 'UR')] };
  t.openCard('C1', { rarity: 'SR', title: 'Paris' }); // avec ventes, moins de 50 : pas de « Tout afficher »
  t.renderCard();
  t.openCard('C1', { rarity: 'L', title: 'Paris' }); // sans vente à cette rareté, d'autres raretés en ont
  t.renderCard();
  t.openCard('C9', { title: 'X' }); // carte inconnue : aucune autre rareté
  t.renderCard();
  assert.deepEqual(bad, []);
});

test('pastille au clavier : Entrée ou Espace ouvrent la fiche, les autres touches non', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 100)] };
  const b = t.badgeFor('C1', null, {});
  b.card.title = 'Paris';
  const el = {};
  t.tipData.set(el, b);
  const calls = [];
  const ev = key => ({ key, target: { closest: () => el }, preventDefault: () => calls.push('prevent'), stopPropagation: () => calls.push('stop') });
  t.badgeKey(ev('a'));
  assert.equal(t.ui.card, null);
  assert.deepEqual(calls, []);
  t.badgeKey(ev('Enter'));
  assert.equal(t.ui.card.id, 'C1');
  t.ui.card = null;
  t.badgeKey(ev(' '));
  assert.equal(t.ui.card.id, 'C1');
  assert.deepEqual(calls, ['prevent', 'stop', 'prevent', 'stop']);
});

// ----- 1.30.1 : la courbe à la taille réelle de la fiche -----
test('courbe : dessinée à la largeur donnée, sans agrandissement (480 à 1 600, 760 sans largeur)', () => {
  const { t } = load();
  const pts = [{ t: NOW - DAY, p: 120, k: 'pro' }, { t: NOW - 2 * DAY, p: 110, k: 'pro' }];
  assert.equal(t.cardChart(pts, [], '30', NOW, null, null, 1200).attrs.viewBox, '0 0 1200 220');
  assert.equal(t.cardChart(pts, [], '30', NOW, null, null, 5000).attrs.viewBox, '0 0 1600 220');
  assert.equal(t.cardChart(pts, [], '30', NOW, null, null, 300).attrs.viewBox, '0 0 480 220');
  assert.equal(t.cardChart(pts, [], '30', NOW, null, null).attrs.viewBox, '0 0 760 220');
});

test('fiche : la courbe prend la largeur du corps de la fiche', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 120), sale(2, 110)] };
  const out = {};
  t.ui.el.cardHead = { replaceChildren() {} };
  t.ui.el.cardBody = { clientWidth: 1224, replaceChildren(...k) { out.body = k; } };
  t.ui.el.cardStatus = { textContent: '' };
  t.openCard('C1', { rarity: 'SR', title: 'X' });
  t.renderCard();
  assert.equal(find(out.body, n => n.tagName === 'svg')[0].attrs.viewBox, '0 0 1200 220');
});
