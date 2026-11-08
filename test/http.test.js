import assert from 'node:assert/strict';
import test from 'node:test';
import { SiteClient } from '../src/http.js';

const originalFetch = globalThis.fetch;

const stubFetch = (handler) => {
  globalThis.fetch = async (url, options) => handler(String(url), options);
};

const restore = (t) => t.after(() => {
  globalThis.fetch = originalFetch;
});

test('fetchPath falls back to another mirror when the first one is blocked', async (t) => {
  restore(t);
  const seen = [];
  stubFetch((url) => {
    seen.push(url);
    return new Response('blocked', { status: url.includes('subhd.tv') ? 403 : 200 });
  });

  const client = new SiteClient(['subhd.tv', 'subhd.me']);
  const response = await client.fetchPath('/search/dune');

  assert.equal(response.status, 200);
  assert.deepEqual(seen, ['https://subhd.tv/search/dune', 'https://subhd.me/search/dune']);
  assert.equal(client.domain, 'subhd.me');
});

test('fetchPath explains the block when every mirror refuses', async (t) => {
  restore(t);
  stubFetch(() => new Response('nope', { status: 403 }));

  const client = new SiteClient(['subhd.tv', 'subhd.me']);
  await assert.rejects(
    () => client.fetchPath('/search/dune'),
    (error) => {
      assert.equal(error.status, 403);
      assert.match(error.message, /出口 IP/);
      return true;
    },
  );
});

// 站点限流也是 403，但它有话说：别当成地域封锁，也别再去别的镜像绕一圈。
test('fetchPath surfaces the site rate limit instead of blaming the egress ip', async (t) => {
  restore(t);
  const seen = [];
  stubFetch((url) => {
    seen.push(url);
    return new Response(JSON.stringify({ success: false, msg: '下载频率过高，请稍后再试。' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  });

  const client = new SiteClient(['subhd.tv', 'subhd.me']);
  await assert.rejects(
    () => client.fetchPath('/api/sub/prepare-download'),
    (error) => {
      assert.equal(error.name, 'RateLimitError');
      assert.equal(error.status, 403);
      assert.match(error.message, /下载频率过高/);
      return true;
    },
  );
  assert.deepEqual(seen, ['https://subhd.tv/api/sub/prepare-download']);
});

test('fetchPath returns ordinary 4xx responses untouched', async (t) => {
  restore(t);
  stubFetch(() => new Response('missing', { status: 404 }));

  const client = new SiteClient(['subhd.tv']);
  const response = await client.fetchPath('/a/zzzzzz');
  assert.equal(response.status, 404);
});

test('fetchPath retries a 5xx on the same mirror before switching', async (t) => {
  restore(t);
  const seen = [];
  stubFetch((url) => {
    seen.push(url);
    return new Response('boom', { status: 502 });
  });

  const client = new SiteClient(['subhd.tv', 'subhd.me']);
  await assert.rejects(() => client.fetchPath('/search/dune'));

  assert.deepEqual(seen, [
    'https://subhd.tv/search/dune',
    'https://subhd.tv/search/dune',
    'https://subhd.me/search/dune',
    'https://subhd.me/search/dune',
  ]);
});

test('network report summarises the egress ip and every mirror', async (t) => {
  restore(t);
  stubFetch((url) =>
    url.includes('ipify')
      ? new Response(JSON.stringify({ ip: '203.0.113.7' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response('blocked', { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
  );

  const { networkReport } = await import('../src/diagnostics.js');
  const report = await networkReport();

  assert.equal(report.egressIp, '203.0.113.7');
  assert.equal(report.domains.length >= 1, true);
  assert.equal(report.domains[0].status, 403);
  assert.equal(report.domains[0]['cf-mitigated'], 'challenge');
  assert.equal(typeof report.runtime.node, 'string');
});

test('fetchPath stops walking mirrors once the budget is spent', async (t) => {
  restore(t);
  let calls = 0;
  stubFetch(() => {
    calls += 1;
    return new Response('blocked', { status: 403 });
  });

  const client = new SiteClient(['subhd.tv', 'subhd.me']);
  await assert.rejects(
    () => client.fetchPath('/search/dune', { deadlineMs: 0 }),
    /无法访问 SubHD/,
  );
  assert.equal(calls, 0);
});
