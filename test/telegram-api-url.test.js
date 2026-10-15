import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function resolveBase(envValue) {
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const env = { ...process.env };
  delete env.TELEGRAM_API_URL;
  if (envValue !== undefined) env.TELEGRAM_API_URL = envValue;
  const res = spawnSync(
    process.execPath,
    ['-e', `import(${JSON.stringify(configUrl)}).then((m) => console.log('BASE=' + m.config.telegramApiBase))`],
    { env, encoding: 'utf8' }
  );
  assert.equal(res.status, 0, res.stderr);
  return /BASE=(.*)/.exec(res.stdout)[1];
}

test('TELEGRAM_API_URL defaults to api.telegram.org', () => {
  assert.equal(resolveBase(undefined), 'https://api.telegram.org');
  assert.equal(resolveBase('  '), 'https://api.telegram.org');
});

test('TELEGRAM_API_URL is used with trailing slashes trimmed', () => {
  assert.equal(resolveBase('https://tg-proxy.example.com/'), 'https://tg-proxy.example.com');
  assert.equal(resolveBase('http://10.0.0.5:8081/tg//'), 'http://10.0.0.5:8081/tg');
});

test('invalid TELEGRAM_API_URL falls back to the default', () => {
  assert.equal(resolveBase('tg-proxy.example.com'), 'https://api.telegram.org');
});

test('parseTelegramApiBase normalizes and rejects invalid values', async () => {
  const { parseTelegramApiBase } = await import('../src/config.js');
  assert.equal(parseTelegramApiBase(' https://p.example.com/ '), 'https://p.example.com');
  assert.equal(parseTelegramApiBase('ftp://p.example.com'), '');
  assert.equal(parseTelegramApiBase('https://'), '');
  assert.equal(parseTelegramApiBase(''), '');
});

test('admin setting overrides env/default and empty value falls back', async () => {
  const { initDb, getTelegramSettings, setTelegramSettings, resolveTelegramApiBase } = await import('../src/db.js');
  initDb();
  assert.equal(resolveTelegramApiBase(), 'https://api.telegram.org');
  setTelegramSettings({ apiUrl: 'https://tg-proxy.example.com/' });
  assert.equal(resolveTelegramApiBase(), 'https://tg-proxy.example.com');
  assert.equal(getTelegramSettings().apiUrl, 'https://tg-proxy.example.com');
  setTelegramSettings({ apiUrl: 'garbage' });
  assert.equal(resolveTelegramApiBase(), 'https://api.telegram.org');
  setTelegramSettings({ apiUrl: 'http://10.0.0.5:8081' });
  setTelegramSettings({ apiUrl: '' });
  assert.equal(resolveTelegramApiBase(), 'https://api.telegram.org');
});
