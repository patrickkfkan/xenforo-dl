import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { chromium } from 'playwright';

test('Chromium exposes final download headers and streams native and inline files', async () => {
  const bytes = Buffer.concat([ Buffer.from('%PDF-1.7\n'), Buffer.alloc(1024 * 1024, 0xa5) ]);
  const expectedHash = createHash('sha256').update(bytes).digest('hex');
  const server = http.createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/inline' });
      response.end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/pdf',
      ...(request.url === '/native' ? { 'content-disposition': 'attachment; filename="exam.pdf"' } : {})
    });
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      response.write(bytes.subarray(offset, offset + 65536));
    }
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    for (const route of [ '/native', '/inline', '/redirect' ]) {
      const page = await context.newPage();
      const session = await context.newCDPSession(page);
      const observed = [];
      let interceptionError;
      session.on('Fetch.requestPaused', (event) => {
        void (async () => {
          if (event.responseStatusCode >= 300 && event.responseStatusCode < 400) {
            await session.send('Fetch.continueResponse', { requestId: event.requestId });
            return;
          }
          observed.push({ status: event.responseStatusCode, headers: event.responseHeaders });
          assert.equal(event.responseStatusCode, 200);
          const headers = event.responseHeaders.filter((header) => header.name.toLowerCase() !== 'content-disposition');
          headers.push({ name: 'Content-Disposition', value: 'attachment; filename="exam.pdf"' });
          await session.send('Fetch.continueResponse', {
            requestId: event.requestId,
            responseCode: event.responseStatusCode,
            responseHeaders: headers
          });
        })().catch((error) => {
          interceptionError = error;
          void page.close();
        });
      });
      await session.send('Fetch.enable', { patterns: [ { urlPattern: `${base}/*`, requestStage: 'Response' } ] });
      const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
      const navigation = page.goto(`${base}${route}`).catch((error) => {
        if (!/Download is starting|ERR_ABORTED/.test(error.message)) {
          throw error;
        }
      });
      const [ download ] = await Promise.all([ downloadPromise, navigation ]);
      assert.equal(interceptionError, undefined);
      const stream = await download.createReadStream();
      assert(stream);
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        hash.update(chunk);
      }
      assert.equal(await download.failure(), null);
      assert.equal(size, bytes.length);
      assert.equal(hash.digest('hex'), expectedHash);
      assert.equal(observed.length, 1);
      assert(observed[0].headers.some((header) => header.name.toLowerCase() === 'content-type' && header.value === 'application/pdf'));
      await download.delete();
      await session.detach();
      await page.close();
    }
  }
  finally {
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
