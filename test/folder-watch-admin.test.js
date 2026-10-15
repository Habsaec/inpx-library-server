import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from '../src/db.js';
import { renderAdminSources } from '../src/templates/admin.js';

initDb();

test('admin sources page shows watch status per folder source and the settings form', () => {
  const sources = [
    { id: 1, name: 'Folder', type: 'folder', path: '/books', enabled: 1, bookCount: 0, lastIndexedAt: '' },
    { id: 2, name: 'Inpx', type: 'inpx', path: '/lib.inpx', enabled: 1, bookCount: 0, lastIndexedAt: '' }
  ];
  const render = (folderWatch) => renderAdminSources({
    user: { username: 'admin', role: 'admin' }, stats: {}, indexStatus: {}, sources, folderWatch
  });
  const watching = render({ config: { enabled: true, quietSec: 90 }, status: { enabled: true, sources: { 1: { status: 'watching' } } } });
  assert.match(watching, /data-watch-status="1"/);
  assert.doesNotMatch(watching, /data-watch-status="2"/, 'INPX sources are not watched');
  assert.match(watching, /action="\/admin\/settings\/folder-watch"/);
  assert.match(watching, /name="quietSec" value="90"/);
  assert.match(watching, /name="enabled" value="1" checked/);

  const failed = render({ config: { enabled: true, quietSec: 120 }, status: { enabled: true, sources: { 1: { status: 'failed', error: 'ENOSPC: limit' } } } });
  assert.match(failed, /title="ENOSPC: limit"/);

  const off = render({ config: { enabled: false, quietSec: 120 }, status: { enabled: false, sources: {} } });
  assert.doesNotMatch(off, /name="enabled" value="1" checked/);
});
