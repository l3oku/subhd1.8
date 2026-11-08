import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { ProxyPool, parseProxyList } from '../src/proxy.js';
import { request } from '../src/http.js';

// ---- 假代理：http 代理（绝对形式 + CONNECT 隧道）和 socks5 代理 ----

function startHttpProxy() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`absolute ${req.method} ${req.url}`);
    const target = new URL(req.url);
    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });

  server.on('connect', (req, clientSocket, head) => {
    seen.push(`connect ${req.url}`);
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  return { server, seen };
}

// 只实现握手到 CONNECT 这一段：够 undici 的 Socks5ProxyAgent 用
function startSocks5Proxy() {
  const seen = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let stage = 'greeting';

    socket.on('error', () => socket.destroy());

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        const count = buffer[1];
        if (buffer.length < 2 + count) return;
        buffer = buffer.subarray(2 + count);
        socket.write(Buffer.from([0x05, 0x00])); // 不需要认证
        stage = 'request';
      }

      if (stage !== 'request') return;
      if (buffer.length < 5) return;

      assert.equal(buffer[0], 0x05);
      assert.equal(buffer[1], 0x01); // CONNECT

      const atyp = buffer[3];
      let cursor = 4;
      let host;
      if (atyp === 0x01) {
        if (buffer.length < cursor + 4 + 2) return;
        host = `${buffer[cursor]}.${buffer[cursor + 1]}.${buffer[cursor + 2]}.${buffer[cursor + 3]}`;
        cursor += 4;
      } else if (atyp === 0x03) {
        const length = buffer[cursor];
        if (buffer.length < cursor + 1 + length + 2) return;
        host = buffer.subarray(cursor + 1, cursor + 1 + length).toString('utf8');
        cursor += 1 + length;
      } else {
        socket.destroy();
        return;
      }

      const port = buffer.readUInt16BE(cursor);
      seen.push(`${host}:${port}`);
      socket.removeListener('data', onData);
      stage = 'tunnel';

      const upstream = net.connect(port, host, () => {
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
    };

    socket.on('data', onData);
  });

  return { server, seen };
}

function startTarget() {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`hello ${req.url}`);
  });
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
// undici 的连接是 keep-alive 的，server.close() 会一直等它们 —— 先把连接掐掉再关
const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });

// 一个 via 用完就把它那条连接池关掉，免得测试卡在「等连接自己结束」
const dispose = async (via) => {
  await via?.dispatcher?.destroy().catch(() => undefined);
};

// ---- 地址解析 ----

test('parseProxyList accepts the usual spellings', () => {
  const list = parseProxyList(
    'http://127.0.0.1:7890, 10.0.0.1:3128\nsocks5://user:p%40ss@node:1080; socks5h://node2:1080',
  );
  assert.deepEqual(
    list.map((entry) => entry.label),
    [
      'http://127.0.0.1:7890',
      'http://10.0.0.1:3128',
      'socks5://user:***@node:1080',
      'socks5://node2:1080',
    ],
  );
  // 密码不出现在任何地方，只有用户名
  assert.ok(!list.map((entry) => entry.label).join(' ').includes('p%40ss'));
  // /healthz 和日志都走 label/state，别把密码带出去
  assert.ok(!JSON.stringify(new ProxyPool(list).state()).includes('p%40ss'));
});

test('parseProxyList drops junk and duplicates', () => {
  const list = parseProxyList('http://a:1,http://a:1,ftp://b:2,nonsense,,: ');
  assert.equal(list.length, 1);
  assert.equal(list[0].label, 'http://a:1');
});

// ---- 池子的取舍 ----

test('pool rotates, cools down and comes back', async () => {
  const pool = new ProxyPool(parseProxyList('http://a:1,http://b:2'));
  assert.equal(pool.enabled, true);
  assert.equal(pool.size, 2);

  const first = await pool.pick();
  const second = await pool.pick();
  assert.notEqual(first.label, second.label, '两个出口轮着用');

  pool.penalize(first, { reason: '站点限流', ms: 1000 });
  const third = await pool.pick();
  assert.equal(third.label, second.label, '被拍的那个先歇着');

  pool.penalize(second, { reason: '站点限流', ms: 1000 });
  assert.equal(await pool.pick(), null, '全被拍就没人可派');
  assert.ok(pool.nextAvailableIn() > 0);

  // 连着被拍要翻倍，隔久了才回到基础值
  assert.equal(pool.state().nodes.find((node) => node.label === first.label).hits, 1);
  pool.penalize(first, { reason: '站点限流', ms: 1000 });
  assert.equal(pool.state().nodes.find((node) => node.label === first.label).hits, 2);
});

test('an empty pool stays disabled', async () => {
  const pool = new ProxyPool([]);
  assert.equal(pool.enabled, false);
  assert.equal(await pool.pick(), null);
  assert.equal(pool.nextAvailableIn(), 0);
  assert.deepEqual(pool.state().nodes, []);
});

test('blocked() tells a site limit apart from a dead exit', async () => {
  const pool = new ProxyPool(parseProxyList('http://a:1,http://b:2'));
  assert.equal(pool.blocked(), null, '有出口可用时没有「被挡住」这回事');

  const first = await pool.pick();
  pool.penalize(first, { reason: '站点限流', kind: 'limit', ms: 5000 });
  assert.equal(pool.blocked().kind, 'limit');

  const second = await pool.pick();
  pool.penalize(second, { reason: '连不上', kind: 'exit', ms: 5000 });
  assert.equal(pool.blocked().kind, 'mixed', '两个出口各有各的原因');
  assert.equal(pool.blocked().cooling, 2);
  assert.equal(await pool.pick(), null);

  pool.penalize(first, { reason: '连不上', kind: 'exit', ms: 5000 });
  assert.equal(pool.blocked().kind, 'exit', '只有一个原因时说得具体点');
});

// ---- 真的从代理走一遍 ----

test('request goes out through an http proxy', async (t) => {
  const target = startTarget();
  const proxy = startHttpProxy();
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy.server);
  t.after(() => close(target));
  t.after(() => close(proxy.server));

  const pool = new ProxyPool(parseProxyList(`http://127.0.0.1:${proxyPort}`));
  const via = await pool.pick();
  t.after(() => dispose(via));
  const response = await request(`http://127.0.0.1:${targetPort}/proxied`, { via });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'hello /proxied');
  assert.deepEqual(proxy.seen, [`absolute GET http://127.0.0.1:${targetPort}/proxied`]);
});

test('request goes out through a socks5 proxy', async (t) => {
  const target = startTarget();
  const proxy = startSocks5Proxy();
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy.server);
  t.after(() => close(target));
  t.after(() => close(proxy.server));

  const pool = new ProxyPool(parseProxyList(`socks5://127.0.0.1:${proxyPort}`));
  const via = await pool.pick();
  t.after(() => dispose(via));
  const response = await request(`http://127.0.0.1:${targetPort}/tunnelled`, { via });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'hello /tunnelled');
  assert.deepEqual(proxy.seen, [`127.0.0.1:${targetPort}`]);
});

test('a dead exit fails the request with the exit named', async () => {
  const pool = new ProxyPool(parseProxyList('http://127.0.0.1:9'));
  const via = await pool.pick();
  try {
    await assert.rejects(
      () => request('http://127.0.0.1:1/nope', { via, timeoutMs: 2000 }),
      (error) => error.message.includes('127.0.0.1:9'),
    );
  } finally {
    await dispose(via);
  }
});
