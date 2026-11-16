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
  received_at INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sales_card ON sales(card, sold_at DESC);
CREATE INDEX IF NOT EXISTS sales_same ON sales(card, sold_at, price);
CREATE UNIQUE INDEX IF NOT EXISTS sales_auction ON sales(auction) WHERE auction IS NOT NULL;
CREATE TABLE IF NOT EXISTS pro_fetch (card TEXT PRIMARY KEY, at INTEGER NOT NULL, member TEXT, rev INTEGER NOT NULL DEFAULT 0);
-- Synchronisation vers un autre pool (mode local, puis NAS). Chaque changement reçoit un numéro de révision strictement
-- croissant (compteur « rev » de meta) : la synchro reprend après la dernière révision envoyée, sans rien sauter.
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS unsold_queue (auction TEXT PRIMARY KEY, rev INTEGER NOT NULL DEFAULT 0);
`;
// Une base créée par une version précédente : on ajoute les révisions, dans l'ordre d'arrivée des lignes.
function migrate(db) {
  const cols = t => db.prepare('PRAGMA table_info(' + t + ')').all().map(c => c.name);
  if (!cols('sales').includes('rev')) db.exec('ALTER TABLE sales ADD COLUMN rev INTEGER NOT NULL DEFAULT 0; UPDATE sales SET rev = id;');
  if (!cols('pro_fetch').includes('rev')) db.exec('ALTER TABLE pro_fetch ADD COLUMN rev INTEGER NOT NULL DEFAULT 0; UPDATE pro_fetch SET rev = rowid;');
  db.exec(`CREATE INDEX IF NOT EXISTS sales_rev ON sales(rev);
    CREATE INDEX IF NOT EXISTS pro_fetch_rev ON pro_fetch(rev);
    CREATE INDEX IF NOT EXISTS unsold_queue_rev ON unsold_queue(rev);
    INSERT OR IGNORE INTO meta (k, v) VALUES ('rev', '0');
    UPDATE meta SET v = MAX(CAST(v AS INTEGER), (SELECT COALESCE(MAX(rev), 0) FROM sales), (SELECT COALESCE(MAX(rev), 0) FROM pro_fetch),
      (SELECT COALESCE(MAX(rev), 0) FROM unsold_queue)) WHERE k = 'rev';`);
}

function openDb(path) {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  migrate(db);
  db.q = {
    byAuction: db.prepare('SELECT * FROM sales WHERE auction = ?'),
    same: db.prepare('SELECT * FROM sales WHERE card = ? AND sold_at = ? AND price = ? AND id IS NOT ? LIMIT 1'),
    nextRev: db.prepare("UPDATE meta SET v = CAST(v AS INTEGER) + 1 WHERE k = 'rev' RETURNING v"),
    insert: db.prepare('INSERT INTO sales (card, price, sold_at, kind, auction, gap, rarity, member, received_at, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    upgrade: db.prepare('UPDATE sales SET price = ?, sold_at = ?, kind = ?, gap = 0, member = ?, received_at = ?, rev = ? WHERE id = ?'),
    setKind: db.prepare('UPDATE sales SET kind = ?, gap = 0, auction = COALESCE(auction, ?), member = ?, received_at = ?, rev = ? WHERE id = ?'),
    setAuction: db.prepare('UPDATE sales SET auction = ?, received_at = ?, rev = ? WHERE id = ?'),
    logUnsold: db.prepare('INSERT INTO unsold_queue (auction, rev) VALUES (?, ?) ON CONFLICT(auction) DO UPDATE SET rev = excluded.rev'),
    remove: db.prepare('DELETE FROM sales WHERE id = ?'),
    dropProv: db.prepare("DELETE FROM sales WHERE auction = ? AND kind = 'prov'"),
    proFetch: db.prepare('INSERT INTO pro_fetch (card, at, member, rev) VALUES (?, ?, ?, ?) ON CONFLICT(card) DO UPDATE SET at = excluded.at, member = excluded.member, rev = excluded.rev WHERE excluded.at > pro_fetch.at'),
    getProFetch: db.prepare('SELECT at, member FROM pro_fetch WHERE card = ?'),
    // Les 20 dernières ventes de chaque rareté (60 au plus) : chaque rareté a son propre historique.
    proRows: db.prepare("SELECT price, sold_at, rarity FROM (SELECT price, sold_at, rarity, ROW_NUMBER() OVER (PARTITION BY COALESCE(rarity, '') ORDER BY sold_at DESC) AS rn " +
      "FROM sales WHERE card = ? AND kind = 'pro') WHERE rn <= 20 ORDER BY sold_at DESC LIMIT 60"),
    obsRows: db.prepare("SELECT price, sold_at, gap, kind, auction, rarity FROM (SELECT price, sold_at, gap, kind, auction, rarity, " +
      "ROW_NUMBER() OVER (PARTITION BY COALESCE(rarity, '') ORDER BY sold_at DESC) AS rn FROM sales WHERE card = ? AND kind IN ('exact', 'prov')) " +
      'WHERE rn <= 20 ORDER BY sold_at DESC LIMIT 60')
  };
  return db;
}

// Une vente reçue. Renvoie 'added', 'upgraded' ou null (déjà connue, rien ne change).
// 1. Même enchère : un prix provisoire est remplacé par un prix final.
// 2. Même carte, même date, même prix : c'est la même vente (souvent l'historique Pro d'un côté, le prix final lu de l'autre).
//    Un provisoire devient final ; une ligne sans enchère reçoit celle qu'on lui apporte. Une ligne Pro reste Pro,
//    pour que l'historique Pro de la carte reste complet.
// 3. Sinon, on l'ajoute.
const nextRev = db => Number(db.q.nextRev.get().v);
function upsertSale(db, r, member, now) {
  const q = db.q;
  const byAuc = r.auction ? q.byAuction.get(r.auction) : null;
  const same = q.same.get(r.card, r.t, r.price, byAuc ? byAuc.id : null);
  if (byAuc) {
    if (byAuc.kind !== 'prov' || r.kind === 'prov') return null;
    if (same && same.kind !== 'prov') {
      q.remove.run(byAuc.id);
      if (!same.auction) q.setAuction.run(r.auction, now, nextRev(db), same.id);
      else q.logUnsold.run(r.auction, nextRev(db)); // le prix provisoire de cette enchère disparaît aussi du pool d'arrivée
      return 'upgraded';
    }
    q.upgrade.run(r.price, r.t, r.kind, member, now, nextRev(db), byAuc.id);
    return 'upgraded';
  }
  if (same) {
    if (same.kind === 'prov' && r.kind !== 'prov') { q.setKind.run(r.kind, r.auction, member, now, nextRev(db), same.id); return 'upgraded'; }
    if (r.auction && !same.auction) { q.setAuction.run(r.auction, now, nextRev(db), same.id); return 'upgraded'; }
    return null;
  }
  q.insert.run(r.card, r.price, r.t, r.kind, r.auction, r.gap || 0, r.rarity, member, now, nextRev(db));
  return 'added';
}

function applyPush(db, push, now) {
  const out = { added: 0, upgraded: 0, dropped: 0 };
  const count = res => { if (res) out[res]++; };
  db.exec('BEGIN');
  try {
    for (const e of push.pro) {
      for (const s of e.sales) count(upsertSale(db, { card: e.card, price: s.price, t: s.t, kind: 'pro', auction: null, rarity: s.rarity || e.rarity }, push.member, now));
      db.q.proFetch.run(e.card, Math.min(e.at, now), push.member, nextRev(db));
    }
    for (const s of push.sales) count(upsertSale(db, { ...s, kind: s.x ? 'exact' : 'prov' }, push.member, now));
    for (const id of push.unsold) {
      out.dropped += Number(db.q.dropProv.run(id).changes);
      db.q.logUnsold.run(id, nextRev(db)); // à transmettre au pool du NAS, qui a peut-être ce prix provisoire
    }
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
      pro: pf || proRows.length ? { at: pf ? pf.at : 0, by: pf ? pf.member : null, sales: proRows.map(r => [r.price, r.sold_at, r.rarity || null]) } : null,
      sales: obsRows.map(r => [r.price, r.sold_at, r.gap, r.kind === 'exact' ? 1 : 0, r.auction || '', r.rarity || null])
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

function getMeta(db, k) {
  const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k);
  return r ? r.v : null;
}
function setMeta(db, k, v) {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}

module.exports = { openDb, applyPush, pullCards, knownAuctions, poolStats, purgeMember, getMeta, setMeta };
