/**
 * @deprecated This worker is no longer used.
 * Source deletion now runs inline in the main process with FTS trigger
 * disable/rebuild, orphan cleanup, and proper cascade handling.
 */
import { initDb, deleteSourceProgressive } from '../src/db.js';

const sourceId = Number(process.argv[2]);
if (!Number.isFinite(sourceId) || sourceId <= 0) {
  console.error('[delete-source-worker] invalid source id');
  process.exitCode = 1;
} else {
  try {
    initDb();
    await deleteSourceProgressive(sourceId, {
      deleteSourceRow: true,
      chunkSize: 500,
      interChunkDelayMs: 8
    });
  } catch (error) {
    console.error('[delete-source-worker] failed:', error?.message || error);
    process.exitCode = 1;
  }
}
