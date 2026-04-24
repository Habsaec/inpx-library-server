/**
 * Smoke-тесты для services/self-update.js — проверяем state-machine
 * (beginUpdate / endUpdate / getUpdateState) и формат update.log.
 * Фактический распаковщик ZIP не дёргаем, чтобы не зависеть от unzipper/диска.
 */
import { test } from 'node:test';
import assert from 'node:assert';

test('beginUpdate устанавливает running, endUpdate сбрасывает', async () => {
  const mod = await import('../src/services/self-update.js');
  const before = mod.getUpdateState();
  assert.strictEqual(typeof before.running, 'boolean');

  assert.strictEqual(mod.beginUpdate(), true);
  assert.strictEqual(mod.getUpdateState().running, true);
  assert.ok(mod.getUpdateState().startedAt > 0);

  // Повторный beginUpdate до истечения таймаута — отказ
  assert.strictEqual(mod.beginUpdate(), false);
  assert.strictEqual(mod.isUpdateTimedOut(), false);

  mod.endUpdate();
  assert.strictEqual(mod.getUpdateState().running, false);
});

test('readUpdateLog возвращает строку (пустую или с содержимым)', async () => {
  const mod = await import('../src/services/self-update.js');
  const log = mod.readUpdateLog();
  assert.strictEqual(typeof log, 'string');
});
