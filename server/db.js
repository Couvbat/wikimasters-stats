// Base du pool : une table de ventes (tout l'historique, toutes sources) et la date du dernier relevé Pro par carte.
'use strict';
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY,
  card TEXT NOT NULL,
  price INTEGER NOT NULL,
  sold_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  auction TEXT,
  gap INTEGER NOT NULL DEFAULT 0,
  rarity TEXT,
  member TEXT,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sales_card ON sales(card, sold_at DESC);
CREATE INDEX IF NOT EXISTS sales_same ON sales(card, sold_at, price);
CREATE UNIQUE INDEX IF NOT EXISTS sales_auction ON sales(auction) WHERE auction IS NOT NULL;
CREATE TABLE IF NOT EXISTS pro_fetch (card TEXT PRIMARY KEY, at INTEGER NOT NULL, member TEXT);
`;

function openDb(path) {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  db.q = {
    byAuction: db.prepare('SELECT * FROM sales WHERE auction = ?'),
    same: db.prepare('SELECT * FROM sales WHERE card = ? AND sold_at = ? AND price = ? AND id IS NOT ? LIMIT 1'),
    insert: db.prepare('INSERT INTO sales (card, price, sold_at, kind, auction, gap, rarity, member, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    upgrade: db.prepare('UPDATE sales SET price = ?, sold_at = ?, kind = ?, gap = 0, member = ?, received_at = ? WHERE id = ?'),
    setKind: db.prepare('UPDATE sales SET kind = ?, gap = 0, auction = COALESCE(auction, ?), member = ?, received_at = ? WHERE id = ?'),
    setAuction: db.prepare('UPDATE sales SET auction = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM sales WHERE id = ?'),
    dropProv: db.prepare("DELETE FROM sales WHERE auction = ? AND kind = 'prov'"),
    proFetch: db.prepare('INSERT INTO pro_fetch (card, at, member) VALUES (?, ?, ?) ON CONFLICT(card) DO UPDATE SET at = excluded.at, member = excluded.member WHERE excluded.at > pro_fetch.at'),
    getProFetch: db.prepare('SELECT at, member FROM pro_fetch WHERE card = ?'),
    proRows: db.prepare("SELECT price, sold_at FROM sales WHERE card = ? AND kind = 'pro' ORDER BY sold_at DESC LIMIT 10"),
    obsRows: db.prepare("SELECT price, sold_at, gap, kind, auction FROM sales WHERE card = ? AND kind IN ('exact', 'prov') ORDER BY sold_at DESC LIMIT 10")
  };
  return db;
}

// Une vente reçue. Renvoie 'added', 'upgraded' ou null (déjà connue, rien ne change).
// 1. Même enchère : un prix provisoire est remplacé par un prix final.
// 2. Même carte, même date, même prix : c'est la même vente (souvent l'historique Pro d'un côté, le prix final lu de l'autre).
//    Un provisoire devient final ; une ligne sans enchère reçoit celle qu'on lui apporte. Une ligne Pro reste Pro,
//    pour que l'historique Pro de la carte reste complet.
// 3. Sinon, on l'ajoute.
function upsertSale(db, r, member, now) {
  const q = db.q;
  const byAuc = r.auction ? q.byAuction.get(r.auction) : null;
  const same = q.same.get(r.card, r.t, r.price, byAuc ? byAuc.id : null);
  if (byAuc) {
    if (byAuc.kind !== 'prov' || r.kind === 'prov') return null;
    if (same && same.kind !== 'prov') {
      q.remove.run(byAuc.id);
      if (!same.auction) q.setAuction.run(r.auction, same.id);
      return 'upgraded';
    }
    q.upgrade.run(r.price, r.t, r.kind, member, now, byAuc.id);
    return 'upgraded';
  }
  if (same) {
    if (same.kind === 'prov' && r.kind !== 'prov') { q.setKind.run(r.kind, r.auction, member, now, same.id); return 'upgraded'; }
    if (r.auction && !same.auction) { q.setAuction.run(r.auction, same.id); return 'upgraded'; }
    return null;
  }
  q.insert.run(r.card, r.price, r.t, r.kind, r.auction, r.gap || 0, r.rarity, member, now);
  return 'added';
}

function applyPush(db, push, now) {
  const out = { added: 0, upgraded: 0, dropped: 0 };
  const count = res => { if (res) out[res]++; };
  db.exec('BEGIN');
  try {
    for (const e of push.pro) {
      for (const s of e.sales) count(upsertSale(db, { card: e.card, price: s.price, t: s.t, kind: 'pro', auction: null, rarity: e.rarity }, push.member, now));
      db.q.proFetch.run(e.card, Math.min(e.at, now), push.member);
    }
    for (const s of push.sales) count(upsertSale(db, { ...s, kind: s.x ? 'exact' : 'prov' }, push.member, now));
    for (const id of push.unsold) out.dropped += Number(db.q.dropProv.run(id).changes);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return out;
}

// Pour chaque carte connue : le dernier relevé Pro (10 ventes) et les 10 dernières ventes observées.
function pullCards(db, ids) {
  const cards = {};
  for (const id of ids) {
    const pf = db.q.getProFetch.get(id);
    const proRows = db.q.proRows.all(id);
    const obsRows = db.q.obsRows.all(id);
    if (!pf && !proRows.length && !obsRows.length) continue;
    cards[id] = {
      pro: pf || proRows.length ? { at: pf ? pf.at : 0, by: pf ? pf.member : null, sales: proRows.map(r => [r.price, r.sold_at]) } : null,
      sales: obsRows.map(r => [r.price, r.sold_at, r.gap, r.kind === 'exact' ? 1 : 0, r.auction || ''])
    };
  }
  return { cards };
}

// Enchères dont le prix final est déjà connu du pool : le client n'a pas besoin de les relire sur le site.
function knownAuctions(db, ids) {
  const exact = {};
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    if (!part.length) continue;
    const rows = db.prepare("SELECT auction, card, price, sold_at FROM sales WHERE kind IN ('exact', 'pro') AND auction IN (" + part.map(() => '?').join(',') + ')').all(...part);
    for (const r of rows) exact[r.auction] = [r.card, r.price, r.sold_at];
  }
  return { exact };
}

function poolStats(db) {
  const r = db.prepare('SELECT COUNT(*) AS sales, COUNT(DISTINCT card) AS cards, COUNT(DISTINCT member) AS members, MAX(received_at) AS lastPushAt FROM sales').get();
  return { sales: Number(r.sales), cards: Number(r.cards), members: Number(r.members), lastPushAt: r.lastPushAt == null ? 0 : Number(r.lastPushAt) };
}

// Retire tout ce qu'un membre a envoyé (données fausses, membre parti). Renvoie le nombre de ventes supprimées.
function purgeMember(db, member) {
  const n = Number(db.prepare('DELETE FROM sales WHERE member = ?').run(member).changes);
  db.prepare('DELETE FROM pro_fetch WHERE member = ?').run(member);
  return n;
}

module.exports = { openDb, applyPush, pullCards, knownAuctions, poolStats, purgeMember };
