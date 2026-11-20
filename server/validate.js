// Contrôle d'un envoi au pool. Les données viennent de scripts de membres : on ne garde que des champs simples et bornés,
// avec les mêmes règles que le script (identifiants sûrs, prix entiers positifs, dates lisibles).
'use strict';

const LIMITS = { pro: 2000, sales: 5000, unsold: 5000, proSales: 200, profileCards: 20000, profileWish: 5000 };
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
      // Chaque vente a sa propre rareté (une même carte se vend à plusieurs raretés) ; à défaut, celle de l'entrée.
      if (t && okPrice(s[0])) sales.push({ price: s[0], t, rarity: rarity(s[2]) });
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

// Paramètres du fil (GET /v1/feed) : since, entier ≥ 0 (0 s'il manque) ; limit, de 1 à 10 000 (5 000 s'il manque).
const FEED_LIMIT = 5000, FEED_MAX = 10000;
function parseFeedQuery(params) {
  const int = (name, dflt, min, max) => {
    const raw = params.get(name);
    if (raw == null) return dflt;
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) throw httpError(400, name + ' invalide');
    return n;
  };
  return { since: int('since', 0, 0, Number.MAX_SAFE_INTEGER), limit: int('limit', FEED_LIMIT, 1, FEED_MAX) };
}

// Profil d'un membre qui partage sa collection : [carte, titre, rareté, exemplaires] et [carte, titre, rareté], rien d'autre.
// Une entrée invalide refuse tout le profil. Rareté inconnue : null ('?' du script compris).
function parseProfile(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'corps invalide');
  if (!okId(body.id)) throw httpError(400, 'id invalide');
  const pseudo = typeof body.pseudo === 'string' ? body.pseudo.trim() : '';
  if (!pseudo || pseudo.length > 40) throw httpError(400, 'pseudo invalide');
  if (typeof body.at !== 'number' || !Number.isFinite(body.at)) throw httpError(400, 'date invalide');
  const entries = (key, max, withCount) => {
    const v = body[key];
    if (!Array.isArray(v)) throw httpError(400, key + ' doit être une liste');
    if (v.length > max) throw httpError(413, 'trop d’entrées dans ' + key);
    return v.map(e => {
      if (!Array.isArray(e) || !okId(e[0]) || typeof e[1] !== 'string' || e[1].length > 200) throw httpError(400, 'entrée invalide dans ' + key);
      const r = e[2] == null || e[2] === '?' ? null : rarity(e[2]);
      if (e[2] != null && e[2] !== '?' && !r) throw httpError(400, 'rareté invalide dans ' + key);
      if (!withCount) return [e[0], e[1], r];
      if (!Number.isInteger(e[3]) || e[3] < 1 || e[3] > 9999) throw httpError(400, 'nombre d’exemplaires invalide');
      return [e[0], e[1], r, e[3]];
    });
  };
  return { id: body.id, pseudo, at: Math.round(body.at), cards: entries('cards', LIMITS.profileCards, true), wish: entries('wish', LIMITS.profileWish, false) };
}

module.exports = { parsePush, parseIds, parseProfile, parseFeedQuery, httpError, okId, LIMITS };
