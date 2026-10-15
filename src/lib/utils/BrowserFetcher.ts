import * as fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { AbortError } from 'node-fetch';
import { ensureDirSync } from 'fs-extra';
import contentDisposition from 'content-disposition';
import type { Browser, BrowserContext, CDPSession, Download, Page, Response } from 'playwright';
import type { Protocol } from 'playwright-core/types/protocol';
import type Fetcher from './Fetcher.js';
import { DownloadAttachmentParams, FetcherError, assertAttachmentContent, assertHTMLResponse, assertResponseStatus, parseHTTPURL } from './Fetcher.js';
import Logger, { commonLog } from './logging/Logger.js';
import { normalizeAbortError, sleepBeforeExecute } from './Misc.js';
import URLHelper from './URLHelper.js';

type FetchArgs = Parameters<Fetcher['fetchHTML']>[0];
type BrowserOptions = { url: string; cookie?: string | null; timeout: number; requireLogin: boolean; channel?: string; signal?: AbortSignal; headless?: boolean };

export default class BrowserFetcher {
  name = 'BrowserFetcher';
  #browser?: Browser;
  #context?: BrowserContext;
  #page?: Page;
  #guards = new WeakMap<Page, Promise<CDPSession>>();
  #closed = false;
  #closing?: Promise<void>;
  #lifetime = new AbortController();
  #queue: Promise<unknown> = Promise.resolve();
  #interrupt?: (error: Error) => void;
  #origin: URL;

  private constructor(private options: BrowserOptions, private logger?: Logger | null) {
    this.#origin = parseHTTPURL(options.url);
  }

  static async getInstance(options: BrowserOptions, logger?: Logger | null): Promise<BrowserFetcher> {
    const instance = new BrowserFetcher(options, logger);
    if (!Number.isSafeInteger(options.timeout) || options.timeout <= 0 || options.timeout > 2147483647) {
      throw new FetcherError('Browser timeout must be a positive integer', options.url, true);
    }
    const cookies = instance.#parseCookies(options.cookie);
    await instance.#operate(options.url, options.signal, async () => {
      if (Number(process.versions.node.split('.')[0]) < 20) {
        throw new FetcherError('Browser mode requires Node.js 20 or newer', options.url, true);
      }
      const { chromium } = await import('playwright').catch(() => {
        throw new FetcherError('Browser mode requires Playwright; install optional dependencies with npm install --include=optional', options.url, true);
      });
      instance.#check(options.url, options.signal);
      const launchOptions: Record<string, unknown> = {
        headless: options.headless ?? false,
        timeout: options.timeout,
        ignoreDefaultArgs: [ '--enable-automation' ],
        args: [ '--disable-blink-features=AutomationControlled' ]
      };
      if (options.channel) {
        launchOptions.channel = options.channel;
      }
      else if (!options.headless) {
        launchOptions.channel = 'chrome';
      }
      try {
        instance.#browser = await chromium.launch(launchOptions);
      }
      catch {
        delete launchOptions.channel;
        instance.#browser = await chromium.launch(launchOptions).catch(() => {
          throw new FetcherError('Cannot start Chromium; install it with npx playwright install chromium', options.url, true);
        });
      }
      if (instance.#closed) {
        await instance.#browser.close();
        instance.#check(options.url, options.signal);
      }
      instance.#browser.on('disconnected', () => {
        instance.close().catch(() => {});
      });
      instance.#context = await instance.#browser.newContext({ acceptDownloads: true });
      await instance.#context.addCookies(cookies);
      await instance.#context.route('**/*', async (route) => {
        const request = route.request();
        let url: URL;
        try {
          url = parseHTTPURL(request.url());
        }
        catch {
          await route.continue().catch(() => {});
          return;
        }
        const topLevel = request.isNavigationRequest() && !request.frame().parentFrame();
        // Native cookies ignore ports. Block these requests before Chromium can send imported credentials.
        if (url.origin !== instance.#origin.origin && (topLevel || url.hostname === instance.#origin.hostname)) {
          if (topLevel) instance.#interrupt?.(new FetcherError('Cross-origin browser navigation or attachment is unsupported', options.url, true));
          await route.abort('blockedbyclient').catch(() => {});
          return;
        }
        await route.continue().catch(() => {});
      });
      instance.#page = await instance.#context.newPage();
      await instance.#guard(instance.#page);
      instance.#page.on('close', () => {
        instance.close().catch(() => {});
      });
      commonLog(logger, 'info', instance.name, 'Use the local browser to verify Cloudflare or log in; the session is temporary.');
      await instance.#navigate(options.url);
    }).catch(async (error: unknown) => {
      await instance.close(); throw error;
    });
    return instance;
  }

  #parseCookies(raw?: string | null) {
    if (!raw?.trim()) return [];
    const invalid = () => new FetcherError('Expected raw Cookie header pairs, not Netscape/JSON or malformed cookie data', this.options.url, true);
    if ([ ...raw ].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || (/^[{[#]/).test(raw.trim())) throw invalid();
    const names = new Set<string>();
    return raw.split(';').map((pair) => {
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (index < 1 || !(/^[!#$%&'*+.^_`|~\w-]+$/).test(name) || names.has(name) || (/[^\x21-\x7e]/).test(value)) throw invalid();
      names.add(name);
      return { name, value, domain: this.#origin.hostname, path: '/', secure: this.#origin.protocol === 'https:' };
    });
  }

  #check(url: string, signal?: AbortSignal) {
    if (signal?.aborted) throw new AbortError('Browser operation aborted');
    if (this.#closed) throw new FetcherError('Browser session is closed', url, true);
  }

  #scope(url: string, base?: string) {
    const target = parseHTTPURL(url, base);
    if (target.origin !== this.#origin.origin) throw new FetcherError('Cross-origin browser navigation or attachment is unsupported', base || url, true);
    return target.toString();
  }

  #guard(page: Page, response?: (event: Protocol.Fetch.requestPausedPayload, session: CDPSession) => Promise<void>, failed?: (error: Error) => void): Promise<CDPSession> {
    let guard = this.#guards.get(page);
    if (!guard) {
      guard = (async () => {
        const session = await this.#context!.newCDPSession(page);
        const { frameTree } = await session.send('Page.getFrameTree');
        let redirects = 0;
        session.on('Fetch.requestPaused', (event) => {
          (async () => {
            const requestStage = event.responseStatusCode === undefined && event.responseErrorReason === undefined;
            let target: URL;
            try {
              target = parseHTTPURL(event.request.url);
            }
            catch {
              if (requestStage) {
                await session.send('Fetch.continueRequest', { requestId: event.requestId });
              }
              else {
                await session.send('Fetch.continueResponse', { requestId: event.requestId });
              }
              return;
            }
            const mainDocument = event.resourceType === 'Document' && event.frameId === frameTree.frame.id;
            if (target.hostname === this.#origin.hostname && target.origin !== this.#origin.origin) {
              throw new FetcherError('Cross-origin browser navigation or attachment is unsupported', this.options.url, true);
            }
            if (mainDocument && !response && target.origin !== this.#origin.origin) {
              throw new FetcherError('Cross-origin browser navigation or attachment is unsupported', this.options.url, true);
            }
            if (requestStage) {
              await session.send('Fetch.continueRequest', { requestId: event.requestId });
              return;
            }
            if (mainDocument && event.responseStatusCode && event.responseStatusCode >= 300 && event.responseStatusCode < 400) {
              const location = event.responseHeaders?.find((header) => header.name.toLowerCase() === 'location')?.value;
              if (!location || ++redirects > 20) {
                throw new FetcherError('Invalid or excessive browser redirects', this.options.url, true);
              }
              const nextURL = parseHTTPURL(location, event.request.url);
              if (nextURL.hostname === this.#origin.hostname && nextURL.origin !== this.#origin.origin) {
                throw new FetcherError('Cross-origin browser navigation or attachment is unsupported', this.options.url, true);
              }
              if (!response && nextURL.origin !== this.#origin.origin) {
                throw new FetcherError('Cross-origin browser navigation or attachment is unsupported', this.options.url, true);
              }
            }
            else if (mainDocument) {
              redirects = 0;
            }
            if (mainDocument && response) {
              await response(event, session);
            }
            else {
              await session.send('Fetch.continueResponse', { requestId: event.requestId });
            }
          })().catch(async (error: unknown) => {
            await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
            const rejection = error instanceof Error ? error : new FetcherError('Browser request was rejected', this.options.url, true);
            if (failed) {
              failed(rejection);
            }
            else {
              this.#interrupt?.(rejection);
            }
          });
        });
        await session.send('Fetch.enable', { patterns: [
          { urlPattern: '*', requestStage: 'Request' },
          { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }
        ] });
        return session;
      })();
      this.#guards.set(page, guard);
    }
    return guard;
  }

  close(): Promise<void> {
    if (!this.#closing) {
      this.#closed = true;
      this.#closing = Promise.resolve().then(async () => {
        await this.#context?.close().catch(() => {});
        await this.#browser?.close().catch(() => {});
      });
      this.#lifetime.abort();
    }
    return this.#closing;
  }

  async #operate<T>(url: string, signal: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#check(url, signal);
    const controller = new AbortController();
    let interrupted: Error | undefined;
    let reject!: (error: Error) => void;
    const stopped = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const cancel = (error: Error) => {
      if (interrupted) return;
      interrupted = error;
      controller.abort();
      this.close().catch(() => {});
      reject(error);
    };
    const aborted = () => cancel(new AbortError('Browser operation aborted'));
    const closed = () => cancel(new FetcherError('Browser session was closed during an operation', url, true));
    const timeout = () => new FetcherError('Browser operation timed out waiting for XenForo, login/verification, or download completion', url, true);
    signal?.addEventListener('abort', aborted, { once: true });
    this.#lifetime.signal.addEventListener('abort', closed, { once: true });
    this.#interrupt = cancel;
    const timer = setTimeout(() => cancel(timeout()), this.options.timeout);
    const task = Promise.resolve().then(() => fn(controller.signal));
    try {
      return await Promise.race([ task, stopped ]);
    }
    catch (error) {
      if (interrupted || (error instanceof Error && error.name === 'TimeoutError')) {
        await this.close();
        // Launch may finish after abort; its continuation closes that late browser without delaying cancellation.
        if (this.#context) await task.catch(() => {});
        throw interrupted || timeout();
      }
      const normalized = normalizeAbortError(error, signal);
      if (normalized instanceof FetcherError && normalized.fatal) await this.close();
      if (normalized instanceof AbortError || normalized instanceof FetcherError) throw normalized;
      throw new FetcherError('Browser operation failed (network, browser, or file I/O)', url, this.#closed);
    }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      this.#lifetime.signal.removeEventListener('abort', closed);
      this.#interrupt = undefined;
    }
  }

  async #enqueue<T>(args: FetchArgs, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#check(args.url, args.signal);
    this.#scope(args.url);
    let started = false;
    let reject!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const aborted = () => {
      if (!started) reject(new AbortError('Queued browser operation aborted'));
    };
    const closed = () => {
      if (!started) reject(new FetcherError('Browser session is closed', args.url, true));
    };
    args.signal?.addEventListener('abort', aborted, { once: true });
    this.#lifetime.signal.addEventListener('abort', closed, { once: true });
    // Ponytail: one serialized browser lane; use separate contexts only if browser throughput becomes necessary.
    const task = this.#queue.then(() => {
      this.#check(args.url, args.signal);
      started = true;
      return this.#operate(args.url, args.signal, (signal) => this.#retry(args, signal, fn));
    });
    this.#queue = task.catch(() => {});
    try {
      return await Promise.race([ task, cancelled ]);
    }
    finally {
      args.signal?.removeEventListener('abort', aborted);
      this.#lifetime.signal.removeEventListener('abort', closed);
    }
  }

  async #retry<T>(args: FetchArgs, signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(args.maxRetries) || args.maxRetries < 0 || !Number.isFinite(args.retryInterval) || args.retryInterval < 0) {
      throw new FetcherError('Invalid browser retry limits', args.url, true);
    }
    for (let attempt = 0; ; attempt++) {
      this.#check(args.url, signal);
      try {
        return await fn(signal);
      }
      catch (error) {
        const transient = error instanceof FetcherError ? !error.fatal : error instanceof Error &&
          (/ERR_(?:CONNECTION_(?:RESET|REFUSED|CLOSED)|NETWORK_CHANGED|EMPTY_RESPONSE)|socket hang up/).test(error.message);
        if (!transient || attempt >= args.maxRetries) throw error;
        commonLog(this.logger, 'warn', this.name, `Transient browser failure; retry ${attempt + 1}/${args.maxRetries}`);
        await sleepBeforeExecute(() => Promise.resolve(), args.retryInterval, signal);
      }
    }
  }

  fetchHTML(args: FetchArgs): Promise<{ html: string; lastURL: string }> {
    return this.#enqueue(args, () => this.#navigate(args.url));
  }

  async fetchFilenameByHeaders(args: FetchArgs): Promise<null> {
    this.#check(args.url, args.signal);
    this.#scope(args.url);
    return null;
  }

  async #navigate(url: string): Promise<{ html: string; lastURL: string }> {
    const page = this.#page!;
    let final: Response | undefined;
    let redirects = 0;
    let resolve!: () => void;
    const successful = new Promise<void>((done) => {
      resolve = done;
    });
    const response = (res: Response) => {
      if (res.frame() !== page.mainFrame() || !res.request().isNavigationRequest()) return;
      final = res;
      try {
        if (res.status() >= 300 && res.status() < 400) {
          if (++redirects > 20 || !res.headers().location) throw new FetcherError('Invalid or excessive browser redirects', url, true);
          this.#scope(res.headers().location, res.url());
        }
        if (res.status() >= 200 && res.status() < 300 && res.headers()['cf-mitigated'] !== 'challenge') resolve();
      }
      catch (error) {
        if (error instanceof Error) this.#interrupt?.(error);
      }
    };
    page.on('response', response);
    const thread = URLHelper.parseThreadURL(url);
    const forum = URLHelper.parseForumURL(url);
    const media = (/\/media\/[^/?]+\.(\d+)(?:\/|$)/).exec(parseHTTPURL(url).pathname);
    const key = thread ? `thread-${thread.id}` : forum?.id ? `forum-${forum.id}` : null;
    try {
      await page.goto(this.#scope(url), { waitUntil: 'domcontentloaded', timeout: this.options.timeout });
      await Promise.all([ successful, page.waitForFunction(({ key, media, login }) => {
        const root = document.documentElement;
        if (!(root.id === 'XF' || root.id === 'XenForo' || root.hasAttribute('data-xf'))) return false;
        if ((/^(?:login|error)(?:_|$)/i).test(root.getAttribute('data-template') || '')) return false;
        if ((/^(?:just a moment\.{0,3}|checking your browser(?:\.{0,3})?|attention required!?\s*\|\s*cloudflare)$/i).test(document.title.trim())) return false;
        if (key && root.getAttribute('data-content-key') !== key) return false;
        if (key?.startsWith('thread-') && !document.querySelector('article.message')) return false;
        if (media && !new RegExp(`^(?:xfmg[-_]media|media)-${media}$`).test(root.getAttribute('data-content-key') || '')) return false;
        return !login || root.getAttribute('data-logged-in') === 'true';
      }, { key, media: media?.[1] || null, login: this.options.requireLogin }, { timeout: this.options.timeout }) ]);
      const html = await page.content();
      const lastURL = this.#scope(page.url());
      if (!final || final.url().split('#')[0] !== lastURL.split('#')[0]) throw new FetcherError('No final browser document response', url, true);
      assertResponseStatus(final.status(), lastURL, final.headers()['cf-mitigated']);
      assertHTMLResponse(html, lastURL, true);
      return { html, lastURL };
    }
    finally {
      page.off('response', response);
    }
  }

  downloadAttachment(params: DownloadAttachmentParams): Promise<void> {
    return this.#enqueue({ ...params, url: params.src }, (signal) => this.#download(params, signal));
  }

  async #download({ src, dest }: DownloadAttachmentParams, signal: AbortSignal): Promise<void> {
    let page: Page | undefined, session: CDPSession | undefined, download: Download | undefined;
    let metadata: { url: string; contentType: string; length?: number } | undefined;
    let ownsPart = false, redirects = 0;
    const destination = path.resolve(dest), part = `${destination}.part`;
    try {
      page = await this.#context!.newPage();
      let resolve!: (value: Download) => void, reject!: (error: unknown) => void;
      const downloaded = new Promise<Download>((done, fail) => {
        resolve = done; reject = fail;
      });
      const aborted = () => reject(new AbortError('Attachment download aborted'));
      signal.addEventListener('abort', aborted, { once: true });
      page.once('close', () => {
        signal.removeEventListener('abort', aborted);
        reject(new FetcherError('Attachment page closed before a complete download', src, true));
      });
      page.on('download', (value) => {
        download = value; resolve(value);
      });
      session = await this.#guard(page, async (event, client) => {
        const requestURL = parseHTTPURL(event.request.url).toString();
        const status = event.responseStatusCode || 0, headers = event.responseHeaders || [];
        const header = (name: string) => headers.find((item) => item.name.toLowerCase() === name)?.value || '';
        if (status >= 300 && status < 400) {
          if (++redirects > 20 || !header('location')) throw new FetcherError('Invalid or excessive attachment redirects', src, true);
          const nextURL = parseHTTPURL(header('location'), requestURL);
          if (nextURL.hostname === this.#origin.hostname && nextURL.origin !== this.#origin.origin) {
            throw new FetcherError('Cross-origin browser navigation or attachment is unsupported', src, true);
          }
          await client.send('Fetch.continueResponse', { requestId: event.requestId });
          return;
        }
        const contentType = header('content-type');
        const html = (/^(?:text\/html|application\/xhtml\+xml)\b/i).test(contentType) || header('cf-mitigated').toLowerCase() === 'challenge';
        if (html) {
          throw new FetcherError('Attachment response is HTML, not a file', src, true);
        }
        assertResponseStatus(status, src, header('cf-mitigated'));
        if (event.request.method !== 'GET' || status === 204 || status === 205 || header('content-range')) throw new FetcherError('Attachment GET returned no complete file', src, true);
        const length = header('content-length');
        metadata = { url: requestURL, contentType,
          length: (!header('content-encoding') || header('content-encoding') === 'identity') && (/^\d+$/).test(length) ? Number(length) : undefined };
        const rewritten = headers.filter((item) => item.name.toLowerCase() !== 'content-disposition');
        rewritten.push({ name: 'Content-Disposition', value: contentDisposition(path.basename(destination)) });
        await client.send('Fetch.continueResponse', { requestId: event.requestId, responseCode: status, responseHeaders: rewritten });
      }, (error) => {
        reject(error);
        page?.close().catch(() => {});
      });
      const navigation = page.goto(this.#scope(src), { waitUntil: 'domcontentloaded', timeout: this.options.timeout }).catch(async (error: unknown) => {
        if (!(error instanceof Error) || !(/Download is starting|ERR_ABORTED/).test(error.message)) throw error;
        await downloaded; // ERR_ABORTED alone does not prove a download occurred.
      });
      [ download ] = await Promise.all([ downloaded, navigation ]);
      if (!metadata || parseHTTPURL(download.url()).toString() !== metadata.url) throw new FetcherError('Download did not originate from a validated attachment GET', src, true);
      const stream = await download.createReadStream();
      ensureDirSync(path.dirname(destination));
      const fd = fs.openSync(part, 'wx');
      ownsPart = true;
      await pipeline(stream, fs.createWriteStream(part, { fd }), { signal });
      if (await download.failure()) throw new FetcherError('Chromium attachment download failed', src);
      const prefix = Buffer.alloc(16384), file = fs.openSync(part, 'r');
      try {
        assertAttachmentContent(metadata.contentType, prefix.subarray(0, fs.readSync(file, prefix, 0, prefix.length, 0)), src);
      }
      finally {
        fs.closeSync(file);
      }
      if (metadata.length !== undefined && fs.statSync(part).size !== metadata.length) throw new FetcherError('Attachment length does not match its GET response', src);
      this.#check(src, signal);
      fs.renameSync(part, destination);
    }
    finally {
      await download?.cancel().catch(() => {});
      await download?.delete().catch(() => {});
      await session?.detach().catch(() => {});
      await page?.close().catch(() => {});
      if (ownsPart) fs.rmSync(part, { force: true });
    }
  }
}
