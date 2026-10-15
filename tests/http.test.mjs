import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { AbortError } from 'node-fetch';
import Fetcher, { FetcherError } from '../dist/lib/utils/Fetcher.js';
import { sleepBeforeExecute } from '../dist/lib/utils/Misc.js';

const retry = { maxRetries: 2, retryInterval: 5 };
const challenge = '<!doctype html><html><title>Just a moment...</title><script>window._cf_chl_opt = {};</script></html>';
const html = '<!doctype html><html id="XF" data-xf="2.3"><body>Forum page</body></html>';
const bytes = Buffer.concat([ Buffer.from('%PDF-1.7\n'), Buffer.from([ 0, 1, 255 ]), Buffer.alloc(1024 * 1024, 0xa5) ]);
const fatal = (error) => error instanceof FetcherError && error.fatal === true;

async function serve(t, handler) {
  const hits = [];
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    hits.push({ method: request.method, path: request.url, cookie: request.headers.cookie ?? null });
    handler(request, response);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    for (const socket of sockets) socket.destroy();
  }));
  return { base: `http://127.0.0.1:${server.address().port}`, hits };
}

async function destination(t) {
  const directory = await mkdtemp(join(tmpdir(), 'xenforo-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'attachment.pdf');
}

async function absent(dest) {
  await assert.rejects(access(dest), { code: 'ENOENT' });
  await assert.rejects(access(`${dest}.part`), { code: 'ENOENT' });
}

for (const [ name, status, headers, body ] of [
  [ '403 Cloudflare challenge', 403, { 'cf-mitigated': 'challenge' }, challenge ],
  [ '200 synthetic Cloudflare challenge', 200, {}, challenge ],
  [ '401 login rejection', 401, {}, html ],
  [ '403 permission rejection', 403, {}, html ]
]) {
  test(`HTML ${name} is fatal without retries`, async (t) => {
    const server = await serve(t, (_request, response) => {
      response.writeHead(status, { 'content-type': 'text/html', ...headers });
      response.end(body);
    });
    await assert.rejects(new Fetcher(null).fetchHTML({ url: server.base, ...retry }), fatal);
    assert.equal(server.hits.length, 1);
  });
}

test('HTML 500 retries and returns the successful response', async (t) => {
  let attempts = 0;
  const server = await serve(t, (_request, response) => {
    response.writeHead(++attempts < 3 ? 500 : 200, { 'content-type': 'text/html' });
    response.end(html);
  });
  const result = await new Fetcher(null).fetchHTML({ url: `${server.base}/page`, ...retry });
  assert.equal(attempts, 3);
  assert.deepEqual(result, { html, lastURL: `${server.base}/page` });
});

test('HTML 500 stops after the configured retry budget', async (t) => {
  const server = await serve(t, (_request, response) => {
    response.writeHead(500);
    response.end('temporary failure');
  });
  await assert.rejects(new Fetcher(null).fetchHTML({ url: server.base, ...retry }),
    (error) => error instanceof FetcherError && error.fatal === false);
  assert.equal(server.hits.length, retry.maxRetries + 1);
});

for (const status of [ 405, 501 ]) {
  test(`HEAD ${status} returns null without retries`, async (t) => {
    const server = await serve(t, (_request, response) => {
      response.writeHead(status, { 'content-disposition': 'attachment; filename="error.html"' });
      response.end();
    });
    assert.equal(await new Fetcher(null).fetchFilenameByHeaders({ url: server.base, ...retry }), null);
    assert.deepEqual(server.hits.map((hit) => hit.method), [ 'HEAD' ]);
  });
}

test('HEAD Cloudflare challenge is fatal without needing a body', async (t) => {
  const server = await serve(t, (_request, response) => {
    response.writeHead(403, { 'cf-mitigated': 'challenge' });
    response.end();
  });
  await assert.rejects(new Fetcher(null).fetchFilenameByHeaders({ url: server.base, ...retry }), fatal);
  assert.deepEqual(server.hits.map((hit) => hit.method), [ 'HEAD' ]);
});

test('relative Location resolves and preserves same-origin cookies and final URL', async (t) => {
  const server = await serve(t, (request, response) => {
    if (request.url === '/start') response.writeHead(302, { location: './final' });
    else response.writeHead(200, { 'content-type': 'text/html' });
    response.end(request.url === '/start' ? '' : html);
  });
  const fetcher = new Fetcher(null, 'session=synthetic-only', server.base);
  const result = await fetcher.fetchHTML({ url: `${server.base}/start`, ...retry });
  assert.deepEqual(result, { html, lastURL: `${server.base}/final` });
  assert.deepEqual(server.hits.map((hit) => hit.cookie), [ 'session=synthetic-only', 'session=synthetic-only' ]);
});

for (const location of [ undefined, 'http://[' ]) {
  test(`redirect with ${location === undefined ? 'missing' : 'invalid'} Location is fatal`, async (t) => {
    const server = await serve(t, (_request, response) => {
      response.writeHead(302, location === undefined ? {} : { location });
      response.end();
    });
    await assert.rejects(new Fetcher(null).fetchHTML({ url: server.base, ...retry }), fatal);
    assert.equal(server.hits.length, 1);
  });
}

test('redirect loop is bounded without restarting the chain as retries', async (t) => {
  let attempts = 0;
  const server = await serve(t, (_request, response) => {
    // Terminate the old unbounded redirect implementation so the RED run cannot hang.
    if (++attempts <= 21) response.writeHead(302, { location: `${server.base}/loop` });
    response.end('loop sentinel');
  });
  await assert.rejects(new Fetcher(null).fetchHTML({ url: `${server.base}/loop`, ...retry }), fatal);
  assert(attempts <= 21, `redirect loop made ${attempts} requests`);
});

test('A -> B -> A redirects keep cookies disabled after leaving the configured origin', async (t) => {
  let origin;
  const foreign = await serve(t, (_request, response) => {
    response.writeHead(302, { location: `${origin.base}/final` });
    response.end();
  });
  origin = await serve(t, (request, response) => {
    if (request.url === '/start') response.writeHead(302, { location: `${foreign.base}/first` });
    response.end(request.url === '/start' ? '' : html);
  });
  const result = await new Fetcher(null, 'session=synthetic-only', origin.base).fetchHTML({ url: `${origin.base}/start`, ...retry });
  assert.equal(result.lastURL, `${origin.base}/final`);
  assert.deepEqual(origin.hits.map((hit) => hit.cookie), [ 'session=synthetic-only', null ]);
  assert.deepEqual(foreign.hits.map((hit) => hit.cookie), [ null ]);
});

for (const method of [ 'fetchHTML', 'fetchFilenameByHeaders', 'downloadAttachment' ]) {
  for (const url of [ 'not a URL', 'data:text/html,not-http', 'file:///synthetic-only' ]) {
    test(`${method} rejects malformed or non-HTTP URL ${url} as fatal`, async (t) => {
      const dest = await destination(t);
      const fetcher = new Fetcher(null);
      const operation = method === 'downloadAttachment'
        ? fetcher.downloadAttachment({ src: url, dest, ...retry })
        : fetcher[method]({ url, ...retry });
      await assert.rejects(operation, fatal);
      await absent(dest);
    });
  }
}

for (const method of [ 'fetchHTML', 'fetchFilenameByHeaders', 'downloadAttachment' ]) {
  test(`${method} treats HTTP 404 as fatal without retries`, async (t) => {
    const server = await serve(t, (_request, response) => {
      response.writeHead(404, { 'content-disposition': 'attachment; filename="missing.pdf"' });
      response.end('not found');
    });
    const dest = await destination(t);
    const fetcher = new Fetcher(null);
    const operation = method === 'downloadAttachment'
      ? fetcher.downloadAttachment({ src: server.base, dest, ...retry })
      : fetcher[method]({ url: server.base, ...retry });
    await assert.rejects(operation, fatal);
    assert.equal(server.hits.length, 1);
    await absent(dest);
  });
}

for (const status of [ 200, 405, 501 ]) {
  test(`HEAD ${status} challenge header overrides otherwise successful or unsupported responses`, async (t) => {
    const server = await serve(t, (_request, response) => {
      response.writeHead(status, { 'cf-mitigated': 'challenge', 'content-disposition': 'attachment; filename="error.pdf"' });
      response.end();
    });
    await assert.rejects(new Fetcher(null).fetchFilenameByHeaders({ url: server.base, ...retry }), fatal);
    assert.equal(server.hits.length, 1);
  });
}

test('HEAD 500 retries and parses the successful filename', async (t) => {
  let attempts = 0;
  const server = await serve(t, (_request, response) => {
    response.writeHead(++attempts < 3 ? 500 : 200, { 'content-disposition': 'attachment; filename="exam.pdf"' });
    response.end();
  });
  assert.equal(await new Fetcher(null).fetchFilenameByHeaders({ url: server.base, ...retry }), 'exam.pdf');
  assert.equal(server.hits.length, 3);
});

test('legacy cookie constructor derives one origin from its first request', async (t) => {
  const origin = await serve(t, (_request, response) => response.end(html));
  const foreign = await serve(t, (_request, response) => response.end(html));
  const fetcher = await Fetcher.getInstance(null, 'session=synthetic-only');
  await fetcher.fetchHTML({ url: origin.base, ...retry });
  await fetcher.fetchHTML({ url: foreign.base, ...retry });
  await fetcher.fetchHTML({ url: origin.base, ...retry });
  assert.deepEqual(origin.hits.map((hit) => hit.cookie), [ 'session=synthetic-only', 'session=synthetic-only' ]);
  assert.deepEqual(foreign.hits.map((hit) => hit.cookie), [ null ]);
});

for (const [ name, body ] of [
  [ 'login form', '<html id="XF" data-xf="2.3"><head><title>Log in</title></head><body><form action="/login/login"><input type="password"></form></body></html>' ],
  [ 'session error', '<html id="XF" data-xf="2.3" data-template="error"><body>Your session has expired.</body></html>' ],
  [ 'unrelated website', '<html><head><title>Not a forum</title></head><body>Unrelated content</body></html>' ]
]) {
  test(`HTML 200 ${name} is fatal before reaching the parser`, async (t) => {
    const server = await serve(t, (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(body);
    });
    await assert.rejects(new Fetcher(null).fetchHTML({ url: server.base, ...retry }), fatal);
    assert.equal(server.hits.length, 1);
  });
}

test('HTML 503 Cloudflare challenge body is fatal rather than treated as a transient server error', async (t) => {
  const server = await serve(t, (_request, response) => {
    response.writeHead(503, { 'content-type': 'text/html' });
    response.end(challenge);
  });
  await assert.rejects(new Fetcher(null).fetchHTML({ url: server.base, ...retry }), fatal);
  assert.equal(server.hits.length, 1);
});

test('an ordinary forum page with a login widget is not mistaken for a login rejection', async (t) => {
  const body = html.replace('Forum page', '<article class="message">Public post</article><form action="/login/login"><input type="password"></form>');
  const server = await serve(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(body);
  });
  assert.deepEqual(await new Fetcher(null).fetchHTML({ url: server.base, ...retry }), { html: body, lastURL: `${server.base}/` });
});

test('Misc abort rejection remains compatible with downloader instanceof node-fetch AbortError', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sleepBeforeExecute(async () => assert.fail('aborted callback must not run'), 5, controller.signal),
    (error) => error instanceof AbortError);
});

test('guest XenForo content with login navigation and Cloudflare detection scripts is valid', async (t) => {
  const body = '<html id="XF" data-xf="2.3" data-content-key="thread-42" data-logged-in="false"><head><title>Fixture thread</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head><body><form action="/login/login"><input type="password"></form><article class="message">A post discussing permission failures and cf-chl markup.</article></body></html>';
  const server = await serve(t, (_request, response) => response.end(body));
  const result = await new Fetcher(null).fetchHTML({ url: `${server.base}/threads/fixture.42/?return=/login/`, ...retry });
  assert.equal(result.html, body);
  assert.equal(server.hits.length, 1);
});

test('invalid configured cookie values are rejected without leaking their contents to errors or logs', async (t) => {
  const server = await serve(t, (_request, response) => response.end(html));
  const messages = [];
  const cookie = 'session=synthetic-do-not-log\r\nInjected: true';
  const logger = { log(entry) { messages.push(entry); } };
  const error = await new Fetcher(logger, cookie, server.base).fetchHTML({ url: server.base, ...retry }).then(() => null, (error) => error);
  assert(fatal(error));
  assert.equal(server.hits.length, 0);
  assert(!String(error).includes('synthetic-do-not-log'));
  assert(!JSON.stringify(messages).includes('synthetic-do-not-log'));
});

test('configured-origin cookies reach HTML, HEAD and attachment requests', async (t) => {
  const dest = await destination(t);
  const server = await serve(t, (request, response) => {
    response.writeHead(200, {
      'content-type': request.url === '/file' ? 'application/pdf' : 'text/html',
      'content-disposition': 'attachment; filename="exam.pdf"'
    });
    response.end(request.url === '/file' ? bytes : html);
  });
  const fetcher = new Fetcher(null, 'session=synthetic-only', server.base);
  await fetcher.fetchHTML({ url: `${server.base}/page`, ...retry });
  assert.equal(await fetcher.fetchFilenameByHeaders({ url: `${server.base}/head`, ...retry }), 'exam.pdf');
  await fetcher.downloadAttachment({ src: `${server.base}/file`, dest, ...retry });
  assert.deepEqual(await readFile(dest), bytes);
  assert.deepEqual(server.hits.map((hit) => hit.cookie), Array(3).fill('session=synthetic-only'));
});

test('foreign direct HTML, HEAD and attachment requests never receive configured cookies', async (t) => {
  const origin = await serve(t, (_request, response) => response.end(html));
  const foreign = await serve(t, (request, response) => {
    response.writeHead(200, { 'content-type': request.url === '/file' ? 'application/pdf' : 'text/html' });
    response.end(request.url === '/file' ? bytes : html);
  });
  const fetcher = new Fetcher(null, 'session=synthetic-only', origin.base);
  await fetcher.fetchHTML({ url: `${foreign.base}/page`, ...retry });
  await fetcher.fetchFilenameByHeaders({ url: `${foreign.base}/head`, ...retry });
  await fetcher.downloadAttachment({ src: `${foreign.base}/file`, dest: await destination(t), ...retry });
  assert.equal(origin.hits.length, 0);
  assert.deepEqual(foreign.hits.map((hit) => hit.cookie), [ null, null, null ]);
});

test('A -> B -> B redirects never re-enable configured-origin cookies', async (t) => {
  const foreign = await serve(t, (request, response) => {
    if (request.url === '/first') response.writeHead(302, { location: `${foreign.base}/final` });
    response.end(request.url === '/first' ? '' : html);
  });
  const origin = await serve(t, (_request, response) => {
    response.writeHead(302, { location: `${foreign.base}/first` });
    response.end();
  });
  const fetcher = new Fetcher(null, 'session=synthetic-only', origin.base);
  assert.equal((await fetcher.fetchHTML({ url: origin.base, ...retry })).lastURL, `${foreign.base}/final`);
  assert.deepEqual(origin.hits.map((hit) => hit.cookie), [ 'session=synthetic-only' ]);
  assert.deepEqual(foreign.hits.map((hit) => hit.cookie), [ null, null ]);
});

for (const [ name, status, headers, body ] of [
  [ '403 challenge', 403, { 'cf-mitigated': 'challenge' }, challenge ],
  [ '403 permission rejection', 403, {}, html ],
  [ '200 challenge', 200, {}, challenge ],
  [ 'HTML response', 200, { 'content-type': 'text/html' }, html ],
  [ 'disguised HTML', 200, {}, String.fromCharCode(0xfeff) + ` \r\n${html}` ],
  [ 'UTF-16LE HTML', 200, {}, Buffer.from(`﻿${html}`, 'utf16le') ],
  [ 'UTF-16BE HTML', 200, {}, Buffer.from(`﻿${html}`, 'utf16le').swap16() ]
]) {
  test(`attachment ${name} is fatal and leaves neither destination nor .part`, async (t) => {
    const dest = await destination(t);
    const touched = [];
    const watcher = watch(dirname(dest), (_event, filename) => touched.push(String(filename)));
    t.after(() => watcher.close());
    const server = await serve(t, (_request, response) => {
      response.writeHead(status, { 'content-type': 'application/octet-stream', ...headers });
      response.write(body.slice(0, 8));
      response.end(body.slice(8));
    });
    const error = await new Fetcher(null).downloadAttachment({ src: server.base, dest, ...retry }).then(() => null, (error) => error);
    await absent(dest);
    await delay(20);
    assert.deepEqual(touched, [], 'invalid payload must be rejected before creating files');
    assert(fatal(error), `expected fatal FetcherError, received ${error?.name ?? 'success'}`);
    assert.equal(server.hits.length, 1);
  });
}

for (const recover of [ true, false ]) {
  test(`attachment socket failure ${recover ? 'retries and preserves streamed binary bytes' : 'stops at the retry budget'}`, async (t) => {
    const dest = await destination(t);
    let attempts = 0;
    const server = await serve(t, (request, response) => {
      if (++attempts < 3 || !recover) return request.socket.destroy();
      response.writeHead(200, { 'content-type': 'application/pdf' });
      for (let offset = 0; offset < bytes.length; offset += 65536) response.write(bytes.subarray(offset, offset + 65536));
      response.end();
    });
    const pending = new Fetcher(null).downloadAttachment({ src: server.base, dest, ...retry });
    if (recover) {
      await pending;
      assert.deepEqual(await readFile(dest), bytes);
      await assert.rejects(access(`${dest}.part`), { code: 'ENOENT' });
    }
    else {
      await assert.rejects(pending, (error) => error instanceof FetcherError && !error.fatal);
      await absent(dest);
    }
    assert.equal(attempts, 3);
  });
}

test('mid-stream socket failures clean partial files before retrying and preserve final bytes', async (t) => {
  const dest = await destination(t);
  let attempts = 0;
  const server = await serve(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/pdf', 'content-length': bytes.length });
    response.write(bytes.subarray(0, 65536));
    if (++attempts < 3) setTimeout(() => response.destroy(), 15);
    else response.end(bytes.subarray(65536));
  });
  await new Fetcher(null).downloadAttachment({ src: server.base, dest, ...retry });
  assert.equal(attempts, 3);
  assert.deepEqual(await readFile(dest), bytes);
  await assert.rejects(access(`${dest}.part`), { code: 'ENOENT' });
});

for (const method of [ 'fetchHTML', 'fetchFilenameByHeaders', 'downloadAttachment' ]) {
  test(`${method} respects a pre-aborted signal without making a request`, async (t) => {
    const server = await serve(t, (_request, response) => response.end(html));
    const dest = await destination(t);
    const controller = new AbortController();
    controller.abort();
    const fetcher = new Fetcher(null);
    const args = { ...retry, signal: controller.signal };
    const operation = method === 'downloadAttachment'
      ? fetcher.downloadAttachment({ src: server.base, dest, ...args })
      : fetcher[method]({ url: server.base, ...args });
    await assert.rejects(operation, (error) => error instanceof AbortError);
    assert.equal(server.hits.length, 0);
    await absent(dest);
  });
}

test('Misc retry delay aborts without executing its callback', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = sleepBeforeExecute(async () => ++calls, 1200, controller.signal);
  const start = performance.now();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 0);
  assert(performance.now() - start < 600, 'abort waited for the retry interval');
});

for (const method of [ 'fetchHTML', 'fetchFilenameByHeaders', 'downloadAttachment' ]) {
  test(`${method} aborts promptly during retry delay without another request`, async (t) => {
    let arrived;
    const requested = new Promise((resolve) => { arrived = resolve; });
    const server = await serve(t, (request) => {
      request.socket.destroy();
      arrived();
    });
    const controller = new AbortController();
    t.after(() => controller.abort());
    const dest = await destination(t);
    const args = { ...retry, retryInterval: 1200, signal: controller.signal };
    const fetcher = new Fetcher(null);
    const operation = method === 'downloadAttachment'
      ? fetcher.downloadAttachment({ src: server.base, dest, ...args })
      : fetcher[method]({ url: server.base, ...args });
    const outcome = operation.then(() => null, (error) => error);
    await requested;
    await delay(50);
    const start = performance.now();
    controller.abort();
    assert.equal((await outcome)?.name, 'AbortError');
    assert(performance.now() - start < 600, 'abort waited for the retry interval');
    assert.equal(server.hits.length, 1);
    await absent(dest);
  });
}

test('aborting an active attachment stream removes .part without committing destination', async (t) => {
  const dest = await destination(t);
  const controller = new AbortController();
  const watcher = watch(dirname(dest), (_event, filename) => {
    if (String(filename) === `${basename(dest)}.part`) controller.abort();
  });
  t.after(() => { watcher.close(); controller.abort(); });
  const server = await serve(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/pdf' });
    let chunks = 0;
    const timer = setInterval(() => {
      response.write(bytes.subarray(0, 65536));
      if (++chunks === 100) response.end();
    }, 5);
    response.once('close', () => clearInterval(timer));
  });
  await assert.rejects(new Fetcher(null).downloadAttachment({ src: server.base, dest, ...retry, signal: controller.signal }),
    { name: 'AbortError' });
  await absent(dest);
});
