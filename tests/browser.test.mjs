import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { inspect } from 'node:util';
import Parser from '../dist/lib/parsers/Parser.js';
import { FetcherError } from '../dist/lib/utils/Fetcher.js';

const retry = { maxRetries: 0, retryInterval: 0 };
const cookie = 'xf_user=synthetic-session==; xf_csrf=synthetic-csrf==';
const bytes = Buffer.alloc(1024 * 1024, 0xa5);
Buffer.from('%PDF-1.7\n').copy(bytes);
const hash = (data) => createHash('sha256').update(data).digest('hex');
const fetcherError = (error) => error instanceof FetcherError;
const abortError = { name: 'AbortError' };
const challenge = '<!doctype html><html><head><title>Just a moment...</title></head><body><div id="cf-challenge-running">Checking your browser</div></body></html>';
const login = '﻿  <!doctype html><html id="XF" data-xf="2.3" data-logged-in="false"><head><title>Log in</title></head><body><form action="/login/login"><input type="password" name="password"></form></body></html>';

async function fixture(t) {
  // Import inside each test: a missing implementation must be RED, not a suite-loading crash.
  const { default: BrowserFetcher } = await import('../dist/lib/utils/BrowserFetcher.js');
  const directory = await mkdtemp(join(tmpdir(), 'xenforo-browser-'));
  const sessions = [];
  const requests = [];
  const trace = [];
  const foreignRequests = [];
  let base, foreignBase, held;
  const thread = (loggedIn, body = 'Fixture post') => `<html id="XF" data-xf="2.3" data-content-key="thread-42" data-logged-in="${loggedIn}"><head><link rel="canonical" href="${base}/threads/fixture.42/"><meta property="og:title" content="Fixture thread"></head><body><article class="message"><div class="message-userContent" data-lb-id="post-7"><article class="message-body">${body}<a href="/attachments/fixture.pdf.9/"><img alt="parsed-caller.pdf"></a></article></div></article></body></html>`;
  const foreign = http.createServer((request, response) => {
    foreignRequests.push({ url: request.url, cookie: request.headers.cookie });
    if (request.url === '/bounce-resource') {
      response.writeHead(302, { location: `${foreignBase}/stolen` });
      response.end();
      return;
    }
    response.end(thread(true));
  });
  const server = http.createServer((request, response) => {
    const route = new URL(request.url, base).pathname;
    const loggedIn = (request.headers.cookie ?? '').includes('xf_user=synthetic-session==');
    requests.push({ route, method: request.method, cookie: request.headers.cookie });
    trace.push(`start ${route}`);
    server.emit(route, response);
    const send = (status, type, body, headers = {}) => {
      trace.push(`end ${route}`);
      response.writeHead(status, { 'content-type': type, ...headers });
      response.end(body);
    };
    const redirect = (to) => send(302, 'text/html', '', to ? { location: to } : {});
    if (route === '/hold') { held = response; return; }
    if (route === '/hang') return;
    if (route === '/slow-first') {
      setTimeout(() => send(200, 'text/html', thread(loggedIn, route)), 100);
      return;
    }
    if (route === '/delayed') {
      send(200, 'text/html', `<html><head><title>Loading</title></head><body><script>setTimeout(() => { document.open(); document.write(${JSON.stringify(thread(loggedIn, 'Rendered by JavaScript'))}); document.close(); }, 100)</script></body></html>`);
      return;
    }
    if (route === '/challenge' || route === '/js-foreign') {
      const target = route === '/challenge' ? `${base}/threads/fixture.42/` : `${foreignBase}/stolen`;
      send(403, 'text/html', challenge.replace('</body>', `<script>setTimeout(() => location.replace(${JSON.stringify(target)}), 100)</script></body>`), { 'cf-mitigated': 'challenge' });
      return;
    }
    if (route === '/stuck') return send(200, 'text/html', challenge);
    if (route === '/foreign') return redirect(`${foreignBase}/stolen`);
    if (route === '/loop') return redirect('/loop');
    if (route === '/no-location') return redirect(null);
    if (route === '/redirect') return redirect('/inline');
    if ([ '/native', '/inline', '/octet', '/stream' ].includes(route)) {
      const headers = route === '/inline' ? {} : { 'content-disposition': 'attachment; filename="server-name.pdf"' };
      if (route === '/stream') {
        response.writeHead(200, { 'content-type': 'application/pdf', 'content-length': bytes.length, ...headers });
        response.write(bytes.subarray(0, 65536));
        return;
      }
      return send(200, route === '/octet' ? 'application/octet-stream' : 'application/pdf', bytes, headers);
    }
    if ([ '/bad-challenge', '/bad-login', '/masquerade' ].includes(route)) {
      return send(200, route === '/masquerade' ? 'application/octet-stream' : 'text/html',
        route === '/bad-challenge' ? challenge : login, { 'content-disposition': 'attachment; filename="not-a-file.pdf"' });
    }
    send(200, 'text/html', thread(route === '/guest' ? false : loggedIn, route));
  });
  t.after(async () => {
    try { await Promise.all(sessions.map((session) => session.close())); }
    finally {
      for (const listener of [ server, foreign ]) listener.closeAllConnections();
      await Promise.all([ server, foreign ].map((listener) => new Promise((resolve) => listener.close(resolve))));
      await rm(directory, { recursive: true, force: true });
    }
  });
  await Promise.all([ server, foreign ].map((listener) => new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))));
  base = `http://127.0.0.1:${server.address().port}`;
  foreignBase = `http://127.0.0.1:${foreign.address().port}`;
  return {
    base, directory, requests, trace, foreignRequests,
    args: (route, signal) => ({ url: `${base}${route}`, ...retry, signal }),
    download: (route, dest, signal) => ({ src: `${base}${route}`, dest, ...retry, signal }),
    hit: (route) => once(server, route, { signal: AbortSignal.timeout(5000) }),
    release: () => { held.writeHead(200, { 'content-type': 'text/html' }); held.end(thread(true, '/hold')); },
    async open(overrides = {}, logger = null) {
      const session = await BrowserFetcher.getInstance({
        url: `${base}/threads/fixture.42/`, cookie: null, timeout: 3000,
        requireLogin: false, headless: true, ...overrides
      }, logger);
      sessions.push(session);
      return session;
    }
  };
}

test('browser initialization waits for JavaScript; a 403 challenge can navigate to a valid 200 thread', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const fetcher = await f.open({ url: `${f.base}/delayed` });
  const rendered = await fetcher.fetchHTML(f.args('/delayed'));
  const parsed = new Parser().parseThreadPage(rendered.html, rendered.lastURL);
  assert.equal(parsed.id, 42);
  assert.equal(parsed.messages[0].body, 'Rendered by JavaScript');
  const challenged = await f.open({ url: `${f.base}/challenge` });
  const result = await challenged.fetchHTML(f.args('/challenge'));
  assert.equal(result.lastURL, `${f.base}/threads/fixture.42/`);
  assert.equal(new Parser().parseThreadPage(result.html, result.lastURL).title, 'Fixture thread');
});

test('requireLogin accepts synthetic named cookies without truncating equals signs', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const fetcher = await f.open({ cookie, requireLogin: true });
  const result = await fetcher.fetchHTML(f.args('/threads/fixture.42/'));
  assert.match(result.html, /data-logged-in="true"/);
  assert(f.requests.some((request) => request.cookie?.includes('xf_user=synthetic-session==')));
  assert(f.requests.some((request) => request.cookie?.includes('xf_csrf=synthetic-csrf==')));
  await assert.rejects(fetcher.fetchHTML(f.args('/guest')), fetcherError);
});

for (const route of [ '/guest', '/stuck' ]) {
  test(`requireLogin rejects ${route === '/guest' ? 'a guest' : 'an unresolved challenge timeout'}`, { timeout: 15000 }, async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.open({ url: `${f.base}${route}`, requireLogin: true, timeout: 600 }), fetcherError);
  });
}

for (const [ label, invalid ] of [
  [ 'Netscape cookie export', '# Netscape HTTP Cookie File\n127.0.0.1\tFALSE\t/\tFALSE\t0\txf_user\tnever-log-this==' ],
  [ 'malformed cookie segment', 'xf_user=never-log-this==; missing-equals' ],
  [ 'cookie header injection', 'xf_user=never-log-this==\r\nx-injected=true' ]
]) {
  test(`browser rejects ${label} without leaking values`, { timeout: 15000 }, async (t) => {
    const f = await fixture(t);
    const logs = [];
    await assert.rejects(f.open({ cookie: invalid }, { log: (entry) => logs.push(inspect(entry)) }), (error) => {
      assert(error instanceof FetcherError);
      assert(!inspect([ error, ...logs ]).includes('never-log-this'));
      return true;
    });
    assert.equal(f.requests.length, 0);
  });
}

test('simultaneous HTML operations are serialized and return their own documents', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const fetcher = await f.open();
  const results = await Promise.all([ '/slow-first', '/second' ].map((route) => fetcher.fetchHTML(f.args(route))));
  assert.deepEqual(results.map((result) => new Parser().parseThreadPage(result.html, result.lastURL).messages[0].body), [ '/slow-first', '/second' ]);
  assert.deepEqual(results.map((result) => result.lastURL), [ `${f.base}/slow-first`, `${f.base}/second` ]);
  assert.deepEqual(f.trace.filter((event) => /\/(slow-first|second)$/.test(event)),
    [ 'start /slow-first', 'end /slow-first', 'start /second', 'end /second' ]);
});

test('native, inline PDF, octet-stream and relative-redirect downloads preserve bytes and the caller parsed filename', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const fetcher = await f.open({ cookie, requireLogin: true });
  const page = await fetcher.fetchHTML(f.args('/threads/fixture.42/'));
  const attachment = new Parser().parseThreadPage(page.html, page.lastURL).messages[0].attachments[0];
  assert.equal(attachment.filename, 'parsed-caller.pdf');
  assert.equal(await fetcher.fetchFilenameByHeaders(f.args('/native')), null);
  assert(!f.requests.some((request) => request.method === 'HEAD'));
  for (const route of [ '/native', '/inline', '/octet', '/redirect' ]) {
    const name = `attach-${attachment.id} - ${attachment.filename}`;
    const dest = join(f.directory, route.slice(1), name);
    assert.equal(await fetcher.downloadAttachment(f.download(route, dest)), undefined);
    const saved = await readFile(dest);
    assert.equal(saved.length, bytes.length);
    assert.equal(hash(saved), hash(bytes));
    assert.deepEqual(await readdir(join(f.directory, route.slice(1))), [ name ]);
  }
});

test('HTTP 200 challenge, HTML login and octet-stream HTML prefix never replace an existing attachment', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const dest = join(f.directory, 'previous.pdf');
  await writeFile(dest, 'keep previous contents');
  for (const route of [ '/bad-challenge', '/bad-login', '/masquerade' ]) {
    const fetcher = await f.open({ cookie, requireLogin: true });
    await assert.rejects(fetcher.downloadAttachment(f.download(route, dest)), fetcherError);
    assert(f.requests.some((request) => request.route === route && request.method === 'GET'));
    assert.equal(await readFile(dest, 'utf8'), 'keep previous contents');
    assert.deepEqual(await readdir(f.directory), [ 'previous.pdf' ]);
    await fetcher.close();
  }
});

test('cross-origin HTTP and JavaScript redirects are rejected before any cookie reaches a second loopback port', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  for (const route of [ '/foreign', '/js-foreign' ]) {
    for (const method of [ 'html', 'download' ]) {
      const fetcher = await f.open({ cookie, requireLogin: true });
      const before = f.requests.length;
      const operation = method === 'html' ? fetcher.fetchHTML(f.args(route))
        : fetcher.downloadAttachment(f.download(route, join(f.directory, 'blocked.pdf')));
      await assert.rejects(operation, fetcherError);
      assert(f.requests.slice(before).some((request) => request.route === route && request.cookie?.includes('synthetic-session==')));
      assert.deepEqual(f.foreignRequests, []);
      assert.deepEqual(await readdir(f.directory), []);
      await fetcher.close();
    }
  }
});

for (const route of [ '/loop', '/no-location', '/hang' ]) {
  test(`browser rejects ${route} for navigation and downloads without leaving partial files`, { timeout: 20000 }, async (t) => {
    const f = await fixture(t);
    for (const method of [ 'html', 'download' ]) {
      const fetcher = await f.open({ timeout: 800 });
      const before = f.requests.length;
      const operation = method === 'html' ? fetcher.fetchHTML(f.args(route))
        : fetcher.downloadAttachment(f.download(route, join(f.directory, 'failed.pdf')));
      await assert.rejects(operation, fetcherError);
      assert(f.requests.slice(before).some((request) => request.route === route));
      assert.deepEqual(await readdir(f.directory), []);
      await fetcher.close();
    }
  });
}

test('the timeout covers an incomplete binary transfer and removes .part', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const fetcher = await f.open({ timeout: 800 });
  await assert.rejects(fetcher.downloadAttachment(f.download('/stream', join(f.directory, 'timed-out.pdf'))), fetcherError);
  assert(f.requests.some((request) => request.route === '/stream'));
  assert.deepEqual(await readdir(f.directory), []);
});

test('aborting queued navigation and download rejects promptly without interrupting active work', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const fetcher = await f.open({ timeout: 10000 });
  const hit = f.hit('/hold');
  const active = fetcher.fetchHTML(f.args('/hold'));
  active.catch(() => {}); // Observe any failure while the queued operations are being checked.
  await hit;
  const controller = new AbortController();
  const rejected = Promise.all([
    assert.rejects(fetcher.fetchHTML(f.args('/never-queued', controller.signal)), abortError),
    assert.rejects(fetcher.downloadAttachment(f.download('/octet', join(f.directory, 'queued.pdf'), controller.signal)), abortError)
  ]);
  controller.abort();
  await Promise.race([ rejected, delay(1500, null, { ref: false }).then(() => assert.fail('queued cancellation waited for the active request')) ]);
  assert(!f.requests.some((request) => [ '/never-queued', '/octet' ].includes(request.route)));
  assert.deepEqual(await readdir(f.directory), []);
  f.release();
  assert.equal((await active).lastURL, `${f.base}/hold`);
});

test('aborting an in-progress browser download cancels the transfer, preserves the destination and removes .part', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const fetcher = await f.open({ timeout: 10000 });
  const dest = join(f.directory, 'previous.pdf');
  await writeFile(dest, 'keep previous contents');
  const controller = new AbortController();
  const hit = f.hit('/stream');
  const rejected = assert.rejects(fetcher.downloadAttachment(f.download('/stream', dest, controller.signal)), abortError);
  const [ response ] = await hit;
  const disconnected = once(response, 'close', { signal: AbortSignal.timeout(5000) });
  controller.abort();
  await rejected;
  await disconnected;
  assert.equal(await readFile(dest, 'utf8'), 'keep previous contents');
  assert.deepEqual(await readdir(f.directory), [ 'previous.pdf' ]);
  await fetcher.close();
  await fetcher.close();
  await assert.rejects(fetcher.fetchHTML(f.args('/after-close')), fetcherError);
});

for (const initializing of [ true, false ]) {
  test(`AbortSignal cancels ${initializing ? 'factory initialization' : 'active HTML navigation'} and closes its request`, { timeout: 20000 }, async (t) => {
    const f = await fixture(t);
    const fetcher = initializing ? null : await f.open({ timeout: 10000 });
    const controller = new AbortController();
    const hit = f.hit('/hold');
    const pending = initializing
      ? f.open({ url: `${f.base}/hold`, timeout: 10000, signal: controller.signal })
      : fetcher.fetchHTML(f.args('/hold', controller.signal));
    const rejected = assert.rejects(pending, abortError);
    const [ response ] = await hit;
    const disconnected = once(response, 'close', { signal: AbortSignal.timeout(5000) });
    controller.abort();
    await rejected;
    await disconnected;
    if (fetcher) await fetcher.close();
  });
}

test('close interrupts active navigation and queued downloads and is idempotent', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const fetcher = await f.open({ timeout: 10000 });
  const hit = f.hit('/hold');
  const closedError = (error) => fetcherError(error) || error.name === 'AbortError';
  const navigation = assert.rejects(fetcher.fetchHTML(f.args('/hold')), closedError);
  await hit;
  const download = assert.rejects(fetcher.downloadAttachment(f.download('/octet', join(f.directory, 'closed.pdf'))), closedError);
  await fetcher.close();
  await Promise.all([ navigation, download ]);
  await fetcher.close();
  assert.deepEqual(await readdir(f.directory), []);
  assert(!f.requests.some((request) => request.route === '/octet'));
  await assert.rejects(fetcher.fetchHTML(f.args('/after-close')), fetcherError);
});
