// Synchronisation d'un pool vers un autre : typiquement le pool local de ton PC vers celui du NAS, une fois le NAS joignable.
// Chaque changement de la base porte un numéro de révision strictement croissant. Un passage envoie, après la dernière révision
// déjà transmise : 1. les ventes ajoutées ou modifiées ; 2. les relevés Pro (date et auteur) ; 3. les enchères finies sans vente.
// Le pool d'arrivée applique ses règles de fusion habituelles : renvoyer la même chose ne crée aucun doublon.
// La position (un seul nombre par catégorie) n'avance qu'après chaque lot accepté : un échec ne fait rien perdre,
// et un changement survenu pendant un envoi prend une révision plus grande, donc il part au passage suivant.
'use strict';
const { getMeta, setMeta } = require('./db');

const BATCH = 1500;      // ventes par lot : bien en dessous des plafonds du serveur (2000 relevés Pro, 5000 ventes, 2 Mo)
const PRO_BATCH = 300;   // relevés Pro par lot : chacun emporte jusqu'à 50 ventes, il faut rester sous 2 Mo
const PRO_SALES = 50;    // ventes par relevé Pro, le plafond du serveur
const UNSOLD_BATCH = 5000;
const NO_FETCH_DATE = 1; // une vente Pro envoyée seule ne doit pas dater le relevé : c'est le passage 2 qui le fait

function syncStatus(db) {
  return { at: Number(getMeta(db, 'sync.okAt') || 0), err: getMeta(db, 'sync.err') || '', sent: Number(getMeta(db, 'sync.sent') || 0) };
}

// 1. Un lot de ventes → un envoi par membre (chaque vente garde le pseudo de celui qui l'a relevée).
function salePayloads(rows) {
  const byMember = new Map();
  for (const r of rows) {
    const m = r.member || 'anonyme';
    if (!byMember.has(m)) byMember.set(m, { pro: new Map(), sales: [] });
    const p = byMember.get(m);
    if (r.kind === 'pro') {
      const l = p.pro.get(r.card) || [];
      l.push([r.price, r.sold_at, r.rarity || null]);
      p.pro.set(r.card, l);
      // La même vente, avec le numéro d'enchère qu'elle a reçu : le pool d'arrivée l'accroche à sa ligne Pro.
      if (r.auction) p.sales.push([r.card, r.price, r.sold_at, 0, 1, r.auction, r.rarity || null]);
    } else {
      p.sales.push([r.card, r.price, r.sold_at, r.gap || 0, r.kind === 'exact' ? 1 : 0, r.auction || '', r.rarity || null]);
    }
  }
  const out = [];
  for (const [member, p] of byMember) {
    const pro = [];
    for (const [card, sales] of p.pro) for (let i = 0; i < sales.length; i += PRO_SALES) pro.push([card, NO_FETCH_DATE, sales.slice(i, i + PRO_SALES)]);
    out.push({ member, pro, sales: p.sales });
  }
  return out;
}

// 2. Un lot de relevés Pro → un envoi par auteur du relevé, avec sa date et les ventes Pro de la carte.
function proPayloads(db, rows) {
  const proSales = db.prepare("SELECT price, sold_at, rarity FROM sales WHERE card = ? AND kind = 'pro' ORDER BY sold_at DESC LIMIT ?");
  const byMember = new Map();
  for (const r of rows) {
    const sales = proSales.all(r.card, PRO_SALES).map(s => [s.price, s.sold_at, s.rarity || null]);
    if (!sales.length) continue; // relevé dont les ventes ont été purgées : rien à transmettre
    const m = r.member || 'anonyme';
    if (!byMember.has(m)) byMember.set(m, []);
    byMember.get(m).push([r.card, Number(r.at), sales]);
  }
  return [...byMember].map(([member, pro]) => ({ member, pro }));
}

async function syncOnce(db, { url, key, fetch: fetchImpl = globalThis.fetch, batch = BATCH, timeoutMs = 30000 }) {
  const base = String(url || '').replace(/\/+$/, '');
  if (!/^https?:\/\/\S+$/.test(base) || !key) throw new Error('adresse ou clé du pool d’arrivée manquante');
  const post = async body => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(base + '/v1/push', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-group-key': key }, body: JSON.stringify(body), signal: ctrl.signal
      });
      if (!r.ok) throw new Error('pool d’arrivée : HTTP ' + r.status + (r.status === 401 ? ' (clé refusée)' : ''));
    } catch (e) {
      if (ctrl.signal.aborted) throw new Error('pool d’arrivée : pas de réponse en ' + Math.round(timeoutMs / 1000) + ' s');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
  // Parcourt une catégorie par révisions croissantes ; la position est un seul nombre, enregistré après chaque lot accepté.
  const drain = async (cursorKey, select, size, send) => {
    let rev = Number(getMeta(db, cursorKey) || 0), n = 0;
    for (;;) {
      const rows = select.all(rev, size);
      if (!rows.length) return n;
      await send(rows);
      rev = Number(rows[rows.length - 1].rev);
      setMeta(db, cursorKey, rev);
      n += rows.length;
    }
  };
  try {
    const sent = await drain('sync.rev', db.prepare('SELECT * FROM sales WHERE rev > ? ORDER BY rev LIMIT ?'), batch,
      async rows => { for (const body of salePayloads(rows)) await post(body); });
    const pro = await drain('sync.proRev', db.prepare('SELECT card, at, member, rev FROM pro_fetch WHERE rev > ? ORDER BY rev LIMIT ?'), PRO_BATCH,
      async rows => { for (const body of proPayloads(db, rows)) await post(body); });
    const unsold = await drain('sync.unsoldRev', db.prepare('SELECT auction, rev FROM unsold_queue WHERE rev > ? ORDER BY rev LIMIT ?'), UNSOLD_BATCH,
      rows => post({ member: 'synchro', unsold: rows.map(r => r.auction) }));
    setMeta(db, 'sync.okAt', Date.now());
    setMeta(db, 'sync.err', '');
    setMeta(db, 'sync.sent', Number(getMeta(db, 'sync.sent') || 0) + sent);
    return { sent, pro, unsold };
  } catch (e) {
    try { setMeta(db, 'sync.err', (e && e.message) || 'erreur'); } catch (e2) { /* base fermée */ }
    throw e;
  }
}

module.exports = { syncOnce, syncStatus };
