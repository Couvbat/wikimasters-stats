// Administration du pool, en ligne de commande dans le conteneur :
//   node /app/admin.js stats            compteurs du pool
//   node /app/admin.js purge <membre>   retire tout ce qu'un membre a envoyé
'use strict';
const { openDb, poolStats, purgeMember } = require('./db');

const [cmd, arg] = process.argv.slice(2);
if (cmd !== 'stats' && !(cmd === 'purge' && arg)) {
  console.error('Usage : node admin.js stats | node admin.js purge <membre>');
  process.exit(1);
}
const db = openDb(process.env.DB_PATH || '/data/pool.db');
if (cmd === 'stats') console.log(JSON.stringify(poolStats(db)));
else console.log(purgeMember(db, arg) + ' ventes supprimées pour « ' + arg + ' ».');
db.close();
