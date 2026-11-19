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
-- Profils des membres qui partagent leur collection et leurs souhaits (amis par le pool). Un par compte WikiMasters.
CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, pseudo TEXT NOT NULL, at INTEGER NOT NULL, cards TEXT NOT NULL, wish TEXT NOT NULL, received_at INTEGER NOT NULL);
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
    INSERT OR IGNORE INTO meta (k, v) VALUES ('pool_id', lower(hex(randomblob(8))));
    UPDATE meta SET v = MAX(CAST(v AS INTEGER), (SELECT COALESCE(MAX(rev), 0) FROM sales), (SELECT COALESCE(MAX(rev), 0) FROM pro_fetch),
      (SELECT COALESCE(MAX(rev), 0) FROM unsold_queue)) WHERE k = 'rev';`);
}

// Ventes rendues au plus par carte et par sorte (Pro, observées) : la même limite que le script.
const MAX_SALES_PER_CARD = 2000;

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
    // Toutes les ventes de la carte, les plus récentes d'abord, avec un garde-fou de 2 000 de chaque sorte.
    proRows: db.prepare("SELECT price, sold_at, rarity FROM sales WHERE card = ? AND kind = 'pro' ORDER BY sold_at DESC LIMIT " + MAX_SALES_PER_CARD),
    obsRows: db.prepare("SELECT price, sold_at, gap, kind, auction, rarity FROM sales WHERE card = ? AND kind IN ('exact', 'prov') ORDER BY sold_at DESC LIMIT " + MAX_SALES_PER_CARD)
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

// Fil des nouveautés (1.4.0) : les lignes des trois tables dont le numéro de révision dépasse `since`, dans l'ordre des numéros,
// `limit` au plus en tout. Le script garde `next` et le renvoie comme `since` à la page suivante.
// Une vente Pro porte aussi la date et l'auteur du relevé de sa carte : sa ligne a pu prendre un numéro plus grand que celui du
// relevé (enchère accrochée après coup), et le relevé arrive alors dans une page précédente, avant les ventes qu'il date. Le serveur traite une requête
// à la fois et un envoi prend ses numéros dans une seule transaction : toute ligne de numéro ≤ `max` est déjà écrite.
function feedRows(db, since, limit) {
  const take = limit + 1;
  const rows = [
    ...db.prepare("SELECT s.rev, s.card, s.price, s.sold_at, s.kind, s.auction, s.gap, s.rarity, f.at AS fat, f.member AS fby FROM sales s " +
      "LEFT JOIN pro_fetch f ON f.card = s.card AND s.kind = 'pro' WHERE s.rev > ? ORDER BY s.rev LIMIT ?").all(since, take)
      .map(r => {
        const v = [Number(r.rev), r.card, r.price, r.sold_at, r.kind, r.auction || '', r.gap, r.rarity || null];
        if (r.kind === 'pro') v.push(r.fat == null ? 0 : Number(r.fat), r.fby || null);
        return { rev: Number(r.rev), t: 'sales', v };
      }),
    ...db.prepare('SELECT rev, card, at, member FROM pro_fetch WHERE rev > ? ORDER BY rev LIMIT ?').all(since, take)
      .map(r => ({ rev: Number(r.rev), t: 'pro', v: [Number(r.rev), r.card, Number(r.at), r.member || null] })),
    ...db.prepare('SELECT rev, auction FROM unsold_queue WHERE rev > ? ORDER BY rev LIMIT ?').all(since, take)
      .map(r => ({ rev: Number(r.rev), t: 'unsold', v: [Number(r.rev), r.auction] }))
  ].sort((a, b) => a.rev - b.rev);
  // Une base d'avant 1.1 a pu donner le même numéro à une vente, un relevé et une enchère invendue (la migration numérotait les
  // ventes par leur id, les relevés par leur rowid). La page ne coupe jamais entre deux lignes de même numéro : la suivante
  // (numéros > next) sauterait les autres. Elle a donc au plus limit + 2 lignes. Chaque table rend limit + 1 lignes, et un
  // numéro y est unique : toutes les lignes du dernier numéro de la page sont déjà lues.
  let end = Math.min(limit, rows.length);
  while (end > 0 && end < rows.length && rows[end].rev === rows[end - 1].rev) end++;
  const page = rows.slice(0, end);
  const out = { pool: getMeta(db, 'pool_id'), max: Number(getMeta(db, 'rev') || 0), next: page.length ? page[page.length - 1].rev : since,
    more: rows.length > end, sales: [], pro: [], unsold: [] };
  for (const r of page) out[r.t].push(r.v);
  return out;
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
  const profiles = Number(db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n);
  return { sales: Number(r.sales), cards: Number(r.cards), members: Number(r.members), lastPushAt: r.lastPushAt == null ? 0 : Number(r.lastPushAt), profiles };
}

// Retire tout ce qu'un membre a envoyé (données fausses, membre parti). Renvoie le nombre de ventes supprimées.
function purgeMember(db, member) {
  const n = Number(db.prepare('DELETE FROM sales WHERE member = ?').run(member).changes);
  db.prepare('DELETE FROM pro_fetch WHERE member = ?').run(member);
  db.prepare('DELETE FROM profiles WHERE pseudo = ?').run(member);
  return n;
}

// Profils (amis par le pool) : le dernier envoyé par chaque compte remplace le précédent.
function putProfile(db, p, now) {
  db.prepare('INSERT INTO profiles (id, pseudo, at, cards, wish, received_at) VALUES (?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET pseudo = excluded.pseudo, at = excluded.at, cards = excluded.cards, wish = excluded.wish, received_at = excluded.received_at')
    .run(p.id, p.pseudo, p.at, JSON.stringify(p.cards), JSON.stringify(p.wish), now);
}
function listProfiles(db) {
  return { profiles: db.prepare('SELECT id, pseudo, at, cards, wish FROM profiles ORDER BY pseudo').all()
    .map(r => ({ id: r.id, pseudo: r.pseudo, at: Number(r.at), cards: JSON.parse(r.cards), wish: JSON.parse(r.wish) })) };
}
function removeProfile(db, id) {
  return Number(db.prepare('DELETE FROM profiles WHERE id = ?').run(id).changes) > 0;
}

function getMeta(db, k) {
  const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k);
  return r ? r.v : null;
}
function setMeta(db, k, v) {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}

module.exports = { openDb, applyPush, pullCards, feedRows, knownAuctions, poolStats, purgeMember, putProfile, listProfiles, removeProfile, getMeta, setMeta };
