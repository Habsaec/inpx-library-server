/**
 * Lightweight worker: opens the database in a clean process (no cached prepared
 * statements), runs WAL checkpoint + VACUUM, then exits.
 *
 * Usage: node scripts/vacuum-worker.js <dbPath>
 * Exit code 0 = success, 1 = failure (message on stderr).
 */
const Database = require('better-sqlite3');

const dbPath = process.argv[2];
if (!dbPath) {
  process.stderr.write('Usage: vacuum-worker.js <dbPath>\n');
  process.exit(1);
}

try {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 30000');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
  db.close();
  process.stdout.write('OK\n');
  process.exit(0);
} catch (err) {
  process.stderr.write(err.message + '\n');
  process.exit(1);
}
