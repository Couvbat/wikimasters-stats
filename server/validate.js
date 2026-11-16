// Contrôle d'un envoi au pool. Les données viennent de scripts de membres : on ne garde que des champs simples et bornés,
// avec les mêmes règles que le script (identifiants sûrs, prix entiers positifs, dates lisibles).
'use strict';

const LIMITS = { pro: 2000, sales: 5000, unsold: 5000, proSales: 50 };
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const httpError = (status, message) => Object.assign(new Error(message), { status });
const okId = v => typeof v === 'string' && v.length > 0 && v.length <= 80 && !BAD_KEYS.has(v);
const okPrice = v => Number.isInteger(v) && v > 0;
const rarity = v => (typeof v === 'string' && /^[A-Z]{1,3}$/.test(v) ? v : null);
// Date normalisée : la même vente envoyée par deux membres doit être reconnue.
const isoDate = v => {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const list = (body, key) => {
  const v = body[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw httpError(400, key + ' doit être une liste');
  if (v.length > LIMITS[key]) throw httpError(413, 'trop d’entrées dans ' + key);
  return v;
};

function parsePush(body, now) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'corps invalide');
  const member = (typeof body.member === 'string' ? body.member.trim().slice(0, 40) : '') || 'anonyme';
  const pro = [];
  for (const e of list(body, 'pro')) {
    if (!Array.isArray(e) || !okId(e[0]) || !Number.isFinite(e[1]) || e[1] <= 0 || !Array.isArray(e[2])) continue;
    const sales = [];
    for (const s of e[2].slice(0, LIMITS.proSales)) {
      const t = Array.isArray(s) ? isoDate(s[1]) : null;
      if (t && okPrice(s[0])) sales.push({ price: s[0], t });
    }
    if (sales.length) pro.push({ card: e[0], at: Math.min(e[1], now), sales, rarity: rarity(e[3]) });
  }
  const sales = [];
  for (const e of list(body, 'sales')) {
    const t = Array.isArray(e) ? isoDate(e[2]) : null;
    if (!t || !okId(e[0]) || !okPrice(e[1])) continue;
    sales.push({
      card: e[0], price: e[1], t, gap: Number.isFinite(e[3]) ? Math.max(0, Math.round(e[3])) : 0,
      x: e[4] === 1 ? 1 : 0, auction: okId(e[5]) ? e[5] : null, rarity: rarity(e[6])
    });
  }
  const unsold = list(body, 'unsold').filter(okId);
  return { member, pro, sales, unsold };
}

// Liste d'identifiants pour pull et known : refus au-delà du plafond, identifiants douteux ignorés.
function parseIds(v, max) {
  if (!Array.isArray(v)) throw httpError(400, 'liste attendue');
  if (v.length > max) throw httpError(400, 'au plus ' + max + ' identifiants');
  return [...new Set(v.filter(okId))];
}

module.exports = { parsePush, parseIds, httpError, okId, LIMITS };
