import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Downloader from '../dist/lib/XenForoDownloader.js';
import fse from 'fs-extra';

const cli = fileURLToPath(new URL('../bin/xenforo-dl.js', import.meta.url));
const optionsModule = new URL('../dist/cli/CLIOptions.js', import.meta.url).href;
const request = { cookie: null, maxRetries: 0, minTime: { page: 0, attachment: 0 } };
const quiet = { log() {} };

async function fixture(t, handler) {
  const directory = await mkdtemp(path.join(tmpdir(), 'xenforo-session-test-'));
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, base: `http://127.0.0.1:${server.address().port}` };
}

function thread(base, page, attachments = true) {
  const next = page === 1 ? `<div class="pageNav"><ul class="pageNav-main"><li class="pageNav-page--current"><a>1</a></li><li><a>2</a></li></ul><a class="pageNav-jump--next" href="${base}/threads/fixture.42/page-2">Next</a></div>` : '';
  const message = (id, file) => `<article class="message"><div class="message-userContent" data-lb-id="post-${id}"><article class="message-body">Fixture post ${id}${attachments ? `<a href="${base}/attachments/${file}.pdf.${id}/"><img alt="${file}.pdf"></a>` : ''}</article></div></article>`;
  return `<html id="XF" data-xf="2.3" data-content-key="thread-42" data-logged-in="true"><head><link rel="canonical" href="${base}/threads/fixture.42/"><meta property="og:title" content="Fixture thread"><meta property="og:site_name" content="Fixture site"></head><body>${page === 1 ? message(1, 'first') + message(2, 'second') : message(3, 'third')}${next}</body></html>`;
}

async function execute(args, cwd) {
  const env = { ...process.env };
  delete env.COOKIE;
  delete env.XENFORO_COOKIE;
  const child = spawn(process.execPath, args, { cwd, env, stdio: [ 'ignore', 'pipe', 'pipe' ] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [ code, signal ] = await once(child, 'close');
  return { code, signal, stdout, stderr };
}

test('CLI browser flags and positive integer timeout survive option parsing', async (t) => {
  const { directory } = await fixture(t, (_request, response) => response.end());
  const program = `import {getCLIOptions} from ${JSON.stringify(optionsModule)}; process.execArgv.length=0; process.argv=[process.execPath,'cli.js','--browser','--browser-login','--browser-timeout','2500','--cookie','xf_user=fixture','https://example.invalid/threads/test.42/']; const {request}=getCLIOptions(); console.log(JSON.stringify({browser:request.browser,browserLogin:request.browserLogin,browserTimeout:request.browserTimeout}));`;
  const result = await execute([ '--input-type=module', '-e', program, 'https://example.invalid/threads/test.42/' ], directory);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { browser: true, browserLogin: true, browserTimeout: 2500 });
});

test('CLI rejects browser-login without browser and invalid browser timeouts', async (t) => {
  const { directory } = await fixture(t, (_request, response) => response.end());
  for (const args of [ [ '--browser-login' ], [ '--browser', '--browser-timeout', '0' ], [ '--browser', '--browser-timeout', '1.5' ], [ '--browser', '--browser-timeout', 'Infinity' ] ]) {
    const result = await execute([ cli, ...args, '--no-prompt', 'https://example.invalid/threads/test.42/' ], directory);
    assert.equal(result.code, 1);
    assert(!result.stderr.includes('xf_user='));
  }
});

test('downloader exposes stats and CLI exits nonzero for a challenge instead of empty success', async (t) => {
  const { directory, base } = await fixture(t, (_request, response) => {
    response.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
    response.end('<html><title>Just a moment...</title></html>');
  });
  const result = await execute([ cli, '--no-prompt', '--max-retries', '0', '--min-time-page', '0', '--out-dir', directory, base ], directory);
  assert.equal(result.code, 1, result.stdout);
  assert(!result.stdout.includes('Download complete'));
  const good = await fixture(t, (_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<html id="XF" data-xf="2.3"><head><title>Empty forum list</title></head><body></body></html>');
  });
  const stats = await new Downloader(good.base, { outDir: directory, noPrompt: true, logger: quiet, request }).start({});
  assert.equal(stats.errorCount, 0);
  assert.equal(stats.processedForumCount, 0);
});

test('failed attachment does not append its message or advance to later pages; continue retries it', async (t) => {
  let failSecond = true;
  let pageTwo = 0;
  let base;
  const scope = await fixture(t, (incoming, response) => {
    if (incoming.url.startsWith('/threads/')) {
      const page = incoming.url.includes('page-2') ? 2 : 1;
      if (page === 2) pageTwo++;
      response.setHeader('content-type', 'text/html');
      response.end(thread(base, page));
      return;
    }
    if (incoming.url.includes('second') && failSecond) {
      response.writeHead(500);
      response.end('Temporary fixture failure');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/pdf' });
    response.end('%PDF-1.7\nfixture bytes');
  });
  ({ base } = scope);
  const settings = { outDir: scope.directory, dirStructure: { site: false, parentForumsAndSections: 'none', thread: false, attachments: false }, noPrompt: true, logger: quiet, request };
  const first = await new Downloader(`${base}/threads/fixture.42/`, settings).start({});
  assert.equal(first.errorCount, 1);
  assert.equal(first.processedMessageCount, 1);
  assert.equal(pageTwo, 0, 'failed page must not skip to a later checkpoint');
  const status = JSON.parse(await readFile(path.join(scope.directory, '.dl-status-42'), 'utf8'));
  assert.equal(status.messageID, 1);
  const files = await readdir(scope.directory);
  const messageFile = files.find((file) => file.startsWith('messages-'));
  const text = await readFile(path.join(scope.directory, messageFile), 'utf8');
  assert(text.includes('Fixture post 1'));
  assert(!text.includes('Fixture post 2'));
  assert(!files.some((file) => file.endsWith('.part')));
  failSecond = false;
  const continued = await new Downloader(`${base}/threads/fixture.42/`, { ...settings, continue: true }).start({});
  assert.equal(continued.errorCount, 0);
  assert.equal(continued.processedMessageCount, 2);
  const finalStatus = JSON.parse(await readFile(path.join(scope.directory, '.dl-status-42'), 'utf8'));
  assert.equal(finalStatus.messageID, 3);
  assert(finalStatus.url.endsWith('/page-2'), 'checkpoint must use actual fetched page URL, not canonical page one');
});

test('checkpoint write failure rolls back the appended message and cleans its temporary file', async (t) => {
  let base;
  const scope = await fixture(t, (_incoming, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(thread(base, 2, false));
  });
  ({ base } = scope);
  const original = fse.renameSync;
  fse.renameSync = (source, destination) => {
    if (path.basename(destination) === '.dl-status-42') {
      throw new Error('Synthetic checkpoint write failure');
    }
    return original(source, destination);
  };
  t.after(() => { fse.renameSync = original; });
  const settings = { outDir: scope.directory, dirStructure: { site: false, parentForumsAndSections: 'none', thread: false, attachments: false }, noPrompt: true, logger: quiet, request };
  const stats = await new Downloader(`${base}/threads/fixture.42/page-2`, settings).start({});
  assert.equal(stats.errorCount, 1);
  assert.equal(stats.processedMessageCount, 0);
  const files = await readdir(scope.directory);
  const output = await readFile(path.join(scope.directory, files.find((file) => file.startsWith('messages-'))), 'utf8');
  assert(!output.includes('Fixture post 3'));
  assert(!files.includes('.dl-status-42'));
  assert(!files.some((file) => file.endsWith('.part')));
});

test('a stale checkpoint fails instead of silently appending or skipping messages', async (t) => {
  let base;
  const scope = await fixture(t, (_incoming, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(thread(base, 2, false));
  });
  ({ base } = scope);
  const settings = { outDir: scope.directory, dirStructure: { site: false, parentForumsAndSections: 'none', thread: false, attachments: false }, continue: true, noPrompt: true, logger: quiet, request };
  await fse.writeJSON(path.join(scope.directory, '.dl-status-42'), { threadID: 42, url: `${base}/threads/fixture.42/page-2`, messageID: 99 });
  await assert.rejects(new Downloader(`${base}/threads/fixture.42/`, settings).start({}), /checkpoint/i);
  const status = await fse.readJSON(path.join(scope.directory, '.dl-status-42'));
  assert.equal(status.messageID, 99);
  assert(!(await readdir(scope.directory)).some((file) => file.startsWith('messages-')));
});

test('SIGINT aborts active work and CLI exits 130', async (t) => {
  let received;
  const ready = new Promise((resolve) => { received = resolve; });
  const { directory, base } = await fixture(t, (incoming, response) => {
    received();
    response.on('close', () => response.destroy());
  });
  const env = { ...process.env };
  delete env.COOKIE;
  delete env.XENFORO_COOKIE;
  const cliModule = new URL('../dist/cli/index.js', import.meta.url).href;
  const program = `import CLI from ${JSON.stringify(cliModule)}; process.execArgv.length=0; process.argv=[process.execPath,'cli.js','--no-prompt','--max-retries','0',${JSON.stringify(base)}]; process.on('message',()=>process.emit('SIGINT')); await new CLI().start();`;
  const child = spawn(process.execPath, [ '--input-type=module', '-e', program ], { cwd: directory, env, stdio: [ 'ignore', 'pipe', 'pipe', 'ipc' ] });
  child.stdout.resume();
  child.stderr.resume();
  await ready;
  child.send('interrupt');
  const [ code ] = await once(child, 'close');
  assert.equal(code, 130);
});
