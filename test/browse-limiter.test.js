import test from 'node:test';
import assert from 'node:assert/strict';

// Бьём лимитер в лоб > BROWSE_MAX_HITS раз и проверяем, что health/диагностика
// не получают 429.
const { browseLimiter } = await import('../src/middleware/rate-limiter-browse.js');

function makeReq(path, ip = '203.0.113.1') {
  return { path, ip, headers: {}, get() { return undefined; } };
}
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    set(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(_body) { this.body = _body; return this; }
  };
}

test('browseLimiter: /health освобождён от лимита', () => {
  for (let i = 0; i < 500; i++) {
    const res = makeRes();
    let nextCalled = false;
    browseLimiter(makeReq('/health'), res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, `/health отказано на итерации ${i}`);
    assert.equal(res.statusCode, 200);
  }
});

test('browseLimiter: /api/index-status и /ready освобождены', () => {
  for (const path of ['/api/index-status', '/ready', '/health/perf']) {
    for (let i = 0; i < 500; i++) {
      const res = makeRes();
      let nextCalled = false;
      browseLimiter(makeReq(path), res, () => { nextCalled = true; });
      assert.equal(nextCalled, true, `${path} отказано на итерации ${i}`);
    }
  }
});

test('browseLimiter: обычные пути всё ещё ограничиваются', () => {
  let nexts = 0;
  let blocked = 0;
  for (let i = 0; i < 500; i++) {
    const res = makeRes();
    browseLimiter(makeReq('/catalog', '198.51.100.7'), res, () => { nexts++; });
    if (res.statusCode === 429) blocked++;
  }
  assert.ok(blocked > 0, 'ожидаем хотя бы один 429 на /catalog');
  assert.ok(nexts > 0 && nexts < 500, 'часть запросов должна пройти, часть — нет');
});
