// Synchronisation d'un pool vers un autre : typiquement le pool local de ton PC vers celui du NAS, une fois le NAS joignable.
// On envoie, dans l'ordre, chaque vente reçue ou modifiée depuis le dernier passage réussi, puis les enchères finies sans vente.
// Le pool d'arrivée applique ses règles de fusion habituelles : renvoyer deux fois la même chose ne crée aucun doublon.
// Un échec ne fait rien perdre : la position n'avance qu'après chaque lot accepté, et le passage suivant reprend là.
'use strict';
const { getMeta, setMeta } = require('./db');

const BATCH = 1500;     // ventes par lot : bien en dessous des plafonds du serveur (2000 relevés Pro, 5000 ventes, 2 Mo)
const PRO_SALES = 50;   // ventes par relevé Pro, le plafond du serveur
const UNSOLD_BATCH = 5000;

function syncStatus(db) {
  return { at: Number(getMeta(db, 'sync.okAt') || 0), err: getMeta(db, 'sync.err') || '', sent: Number(getMeta(db, 'sync.sent') || 0) };
}

// Les envois d'un lot de lignes, un par membre (chaque vente garde le pseudo de celui qui l'a relevée).
function payloads(db, rows) {
  const pf = db.prepare('SELECT at FROM pro_fetch WHERE card = ?');
  const byMember = new Map();
  for (const r of rows) {
    const m = r.member || 'anonyme';
    if (!byMember.has(m)) byMember.set(m, { pro: new Map(), sales: [] });
    const p = byMember.get(m);
    if (r.kind === 'pro') {
      const e = p.pro.get(r.card) || { at: 0, sales: [] };
      e.sales.push([r.price, r.sold_at, r.rarity || null]);
      e.at = Math.max(e.at, r.received_at);
      p.pro.set(r.card, e);
    } else {
      p.sales.push([r.card, r.price, r.sold_at, r.gap || 0, r.kind === 'exact' ? 1 : 0, r.auction || '', r.rarity || null]);
    }
  }
  const out = [];
  for (const [member, p] of byMember) {
    const pro = [];
    for (const [card, e] of p.pro) {
      const known = pf.get(card);
      const at = known ? Number(known.at) : e.at; // la date du relevé Pro, pour que le pool d'arrivée garde le plus récent
      for (let i = 0; i < e.sales.length; i += PRO_SALES) pro.push([card, at, e.sales.slice(i, i + PRO_SALES)]);
    }
    out.push({ member, pro, sales: p.sales });
  }
  return out;
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
  let sent = 0, unsold = 0;
  try {
    let at = Number(getMeta(db, 'sync.at') || 0), id = Number(getMeta(db, 'sync.id') || 0);
    const next = db.prepare('SELECT * FROM sales WHERE received_at > ? OR (received_at = ? AND id > ?) ORDER BY received_at, id LIMIT ?');
    for (;;) {
      const rows = next.all(at, at, id, batch);
      if (!rows.length) break;
      for (const body of payloads(db, rows)) await post(body);
      const last = rows[rows.length - 1];
      at = Number(last.received_at);
      id = Number(last.id);
      setMeta(db, 'sync.at', at);
      setMeta(db, 'sync.id', id);
      sent += rows.length;
    }
    let uat = Number(getMeta(db, 'sync.unsoldAt') || 0), uid = getMeta(db, 'sync.unsoldId') || '';
    const nextU = db.prepare('SELECT auction, at FROM unsold_log WHERE at > ? OR (at = ? AND auction > ?) ORDER BY at, auction LIMIT ?');
    for (;;) {
      const rows = nextU.all(uat, uat, uid, UNSOLD_BATCH);
      if (!rows.length) break;
      await post({ member: 'synchro', unsold: rows.map(r => r.auction) });
      const last = rows[rows.length - 1];
      uat = Number(last.at);
      uid = last.auction;
      setMeta(db, 'sync.unsoldAt', uat);
      setMeta(db, 'sync.unsoldId', uid);
      unsold += rows.length;
    }
    setMeta(db, 'sync.okAt', Date.now());
    setMeta(db, 'sync.err', '');
    setMeta(db, 'sync.sent', Number(getMeta(db, 'sync.sent') || 0) + sent);
    return { sent, unsold };
  } catch (e) {
    try { setMeta(db, 'sync.err', (e && e.message) || 'erreur'); } catch (e2) { /* base fermée */ }
    throw e;
  }
}

module.exports = { syncOnce, syncStatus };
