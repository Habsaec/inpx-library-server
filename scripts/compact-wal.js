import fs from 'node:fs';
import { db, compactWalExclusive } from '../src/db.js';
import { config } from '../src/config.js';

const result = compactWalExclusive();
console.log(JSON.stringify(result, null, 2));
try {
  db.close();
} catch {
  /* ignore */
}
for (const f of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) {
  try {
    const st = fs.statSync(f);
    console.log(`${f}: ${(st.size / 1e9).toFixed(3)} GB`);
  } catch {
    console.log(`${f}: missing`);
  }
}
