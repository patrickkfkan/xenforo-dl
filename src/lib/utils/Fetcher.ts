import * as fs from 'fs';
import fetch, { AbortError, Request, Response } from 'node-fetch';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { URL } from 'url';
import path from 'path';
import Logger, { LogLevel, commonLog } from './logging/Logger.js';
import { ensureDirSync } from 'fs-extra';
import { normalizeAbortError, sleepBeforeExecute } from './Misc.js';
import { load as cheerioLoad } from 'cheerio';
import contentDisposition from 'content-disposition';

export interface DownloadAttachmentParams {
  // Attachment src (URL)
  src: string;
  // Destination path
  dest: string;
  maxRetries: number,
  retryInterval: number,
  signal?: AbortSignal;
}

export interface StartDownloadOverrides {
  destFilePath?: string;
  tmpFilePath?: string;
}

export class FetcherError extends Error {

  url: string;
  fatal: boolean;

  constructor(message: string, url: string, fatal = false) {
    super(message);
    this.name = 'FetcherError';
    this.url = url;
    this.fatal = fatal;
  }
}

export function parseHTTPURL(url: string, base?: string | URL): URL {
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  }
  catch {
    throw new FetcherError('Invalid HTTP(S) URL', base?.toString() || '', true);
  }
  if (![ 'http:', 'https:' ].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new FetcherError('Expected HTTP(S) URL without embedded credentials', parsed.origin, true);
  }
  return parsed;
}

export function assertResponseStatus(status: number, url: string, cfMitigated?: string | null): void {
  if (cfMitigated?.toLowerCase() === 'challenge') {
    throw new FetcherError('Cloudflare challenge requires browser verification', url, true);
  }
  if (status < 200 || status >= 300) {
    const transient = status >= 500 || status === 408 || status === 429;
    throw new FetcherError(`HTTP ${status}`, url, !transient);
  }
}

export function assertHTMLResponse(html: string, url: string, requireXenForo = false): void {
  const $ = cheerioLoad(html);
  const root = $('html');
  const title = $('title').first().text().trim();
  const xenforo = root.is('#XF, #XenForo, [data-xf], [data-content-key]');
  // Cloudflare's passive JS detection also runs on real forum pages; it is not a challenge.
  const challenge = (/^(?:just a moment\.{0,3}|checking your browser(?:\.{0,3})?|attention required!?\s*\|\s*cloudflare)$/i).test(title) ||
    (!xenforo && ($('#cf-challenge-running, #challenge-form, [id^="cf-chl-"]').length > 0 ||
      $('script').toArray().some((script) => (/_cf_chl_opt/i).test($(script).text()))));
  if (challenge) {
    throw new FetcherError('Cloudflare challenge requires browser verification', url, true);
  }
  const template = root.attr('data-template') || '';
  const forumContent = (/^(?:thread|forum)-/).test(root.attr('data-content-key') || '') ||
    (/^(?:thread_view|forum_view|forum_list|xfmg_media_view)$/).test(template) ||
    $('article.message, .structItem--thread, .node--forum, .node-title, .message--simple').length > 0;
  const loginForm = $('form[action*="login"] input[type="password"]').length > 0;
  if ((/^login(?:_|$)/i).test(template) || (/\/(?:login|sign-in)(?:\/|$)/i).test(parseHTTPURL(url).pathname) || (loginForm && !forumContent)) {
    throw new FetcherError('Login required or session expired', url, true);
  }
  if ((/^error(?:_|$)/i).test(template) || (!forumContent && $('.blockMessage--error, .errorOverlay').length > 0)) {
    throw new FetcherError('Forum returned a permission or session error', url, true);
  }
  if (requireXenForo && !xenforo) {
    throw new FetcherError('Response is not a XenForo page', url, true);
  }
}

export function assertAttachmentContent(contentType: string | null, prefixBuffer: Uint8Array, url: string): void {
  let bytes = Buffer.from(prefixBuffer);
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
  if (utf16) {
    bytes = bytes.subarray(0, bytes.length - bytes.length % 2);
    if (bytes[0] === 0xfe) {
      bytes.swap16();
    }
  }
  const prefix = bytes.toString(utf16 ? 'utf16le' : 'utf8').trimStart()
    .replace(/^(?:<\?xml[^>]*>\s*|<!--[\s\S]*?-->\s*)*/i, '');
  if ((/^(?:text\/html|application\/xhtml\+xml)\b/i).test(contentType?.trim() || '') ||
      (/^(?:<!doctype\s+html\b|<(?:html|head|body|title|form|script|div)\b)/i).test(prefix)) {
    throw new FetcherError('Attachment response is HTML, not a file', url, true);
  }
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0';
const MAX_REDIRECTS = 20;
const ATTACHMENT_PREFIX_BYTES = 16384;

export default class Fetcher {

  name = 'Fetcher';

  #logger?: Logger | null;
  #cookie?: string | null;
  #cookieOrigin?: string;

  constructor(logger?: Logger | null, cookie?: string | null, configuredOrigin?: string | null) {
    this.#logger = logger;
    this.#cookie = cookie;
    this.#cookieOrigin = configuredOrigin == null ? undefined : parseHTTPURL(configuredOrigin).origin;
  }

  static async getInstance(logger?: Logger | null, cookie?: string | null, configuredOrigin?: string | null) {
    return new Fetcher(logger, cookie, configuredOrigin);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  async fetchHTML(args: {
    url: string,
    maxRetries: number,
    retryInterval: number,
    signal?: AbortSignal
  }, rt = 0): Promise<{html: string, lastURL: string}> {

    const { url, maxRetries, retryInterval, signal } = args;
    let res: Response | undefined;
    try {
      res = await this.#fetchWithRedirect(url, 'GET', signal);
      let statusError: unknown;
      try {
        this.#assertResponseOK(res, url);
      }
      catch (error) {
        if (!(error instanceof FetcherError) || error.fatal) {
          throw error;
        }
        statusError = error;
      }
      // A challenge body makes even a nominally retryable 503 terminal.
      const html = await res.text();
      assertHTMLResponse(html, res.url, !statusError);
      if (statusError) {
        throw statusError;
      }
      return { html, lastURL: res.url };
    }
    catch (caught) {
      const error = normalizeAbortError(caught, signal);
      if (error instanceof AbortError || (error instanceof FetcherError && error.fatal)) {
        throw error;
      }
      if (rt < maxRetries) {
        this.log('error', `Error fetching "${url}" - will retry: `, error);
        return sleepBeforeExecute(() => this.fetchHTML({ url, maxRetries, retryInterval, signal }, rt + 1), retryInterval, signal);
      }
      const errMsg = error instanceof Error ? error.message : error;
      const retriedMsg = rt > 0 ? ` (retried ${rt} times)` : '';
      throw new FetcherError(`${errMsg}${retriedMsg}`, url);
    }
    finally {
      (res?.body as Readable | null)?.destroy();
    }
  }

  async fetchFilenameByHeaders(args: {
    url: string,
    maxRetries: number,
    retryInterval: number,
    signal?: AbortSignal
  }, rt = 0): Promise<string | null> {

    const { url, maxRetries, retryInterval, signal } = args;
    let res: Response | undefined;
    try {
      res = await this.#fetchWithRedirect(url, 'HEAD', signal);
      if (res.status === 405 || res.status === 501) {
        return null;
      }
      this.#assertResponseOK(res, url, false);
      const disposition = res.headers.get('content-disposition');
      if (disposition) {
        const parsedDisposition = contentDisposition.parse(disposition);
        const filename = parsedDisposition.parameters['filename'] || null;
        return filename;
      }
      return null;
    }
    catch (caught) {
      const error = normalizeAbortError(caught, signal);
      if (error instanceof AbortError || (error instanceof FetcherError && error.fatal)) {
        throw error;
      }
      if (rt < maxRetries) {
        this.log('error', `Error fetching "${url}" (HEAD) - will retry: `, error);
        return sleepBeforeExecute(() => this.fetchFilenameByHeaders({ url, maxRetries, retryInterval, signal }, rt + 1), retryInterval, signal);
      }
      const errMsg = error instanceof Error ? error.message : error;
      const retriedMsg = rt > 0 ? ` (retried ${rt} times)` : '';
      throw new FetcherError(`${errMsg}${retriedMsg}`, url);
    }
    finally {
      (res?.body as Readable | null)?.destroy();
    }
  }

  async downloadAttachment(params: DownloadAttachmentParams, rt = 0): Promise<void> {
    const { src, dest, maxRetries, retryInterval, signal } = params;
    let res: Response | undefined;
    try {
      res = await this.#fetchWithRedirect(src, 'GET', signal);
      if (this.#assertResponseOK(res, src)) {
        const contentType = res.headers.get('content-type');
        assertAttachmentContent(contentType, Buffer.alloc(0), res.url);
        const iterator = (res.body as Readable)[Symbol.asyncIterator]();
        const chunks: Buffer[] = [];
        let prefixLength = 0;
        // Ponytail: sniff only the first 16 KiB; increase this cap if real error pages hide HTML beyond it.
        while (prefixLength < ATTACHMENT_PREFIX_BYTES) {
          const { value, done } = await iterator.next();
          if (done) {
            break;
          }
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          chunks.push(chunk);
          prefixLength += chunk.length;
        }
        assertAttachmentContent(contentType, Buffer.concat(chunks, Math.min(prefixLength, ATTACHMENT_PREFIX_BYTES)), res.url);
        if (signal?.aborted) {
          throw new AbortError('Download aborted');
        }
        const source = Readable.from((async function*() {
          yield* chunks;
          for (;;) {
            const { value, done } = await iterator.next();
            if (done) {
              return;
            }
            yield value;
          }
        })());
        const destFilePath = path.resolve(dest);
        const { dir: destDir, base: destFilename } = path.parse(destFilePath);
        const tmpFilePath = path.resolve(destDir, `${destFilename}.part`);
        try {
          ensureDirSync(destDir);
          this.log('debug', `Download: "${src}" -> "${tmpFilePath}"`);
          await pipeline(source, fs.createWriteStream(tmpFilePath), { signal });
          if (signal?.aborted) {
            throw new AbortError('Download aborted');
          }
          this.#commitDownload(tmpFilePath, destFilePath);
          return;
        }
        catch (error) {
          this.#cleanupDownload(tmpFilePath);
          throw error;
        }
      }
    }
    catch (caught) {
      const error = normalizeAbortError(caught, signal);
      if (error instanceof AbortError || (error instanceof FetcherError && error.fatal)) {
        throw error;
      }
      if (rt < maxRetries) {
        this.log('error', `Error downloading attachment from  "${src}" - will retry: `, error);
        return sleepBeforeExecute(() => this.downloadAttachment(params, rt + 1), retryInterval, signal);
      }
      const errMsg = error instanceof Error ? error.message : error;
      const retriedMsg = rt > 0 ? ` (retried ${rt} times)` : '';
      throw new FetcherError(`${errMsg}${retriedMsg}`, src);
    }
    finally {
      (res?.body as Readable | null)?.destroy();
    }

    return undefined as never;
  }

  async #fetchWithRedirect(url: string, method: 'GET' | 'HEAD', signal?: AbortSignal): Promise<Response> {
    let currentURL = parseHTTPURL(url);
    // Legacy cookie callers bind to the first request's origin, not each attachment host.
    if (this.#cookie && !this.#cookieOrigin) {
      this.#cookieOrigin = currentURL.origin;
    }
    let useCookie = currentURL.origin === this.#cookieOrigin;
    for (let redirects = 0; ; redirects++) {
      const request = new Request(currentURL.toString(), { method });
      this.#setHeaders(request, useCookie);
      const res = await fetch(request, { signal, redirect: 'manual' });
      try {
        // A challenge header is authoritative even on redirects or unsupported HEAD responses.
        assertResponseStatus(200, res.url, res.headers.get('cf-mitigated'));
        if (res.status < 300 || res.status >= 400) {
          return res;
        }
        const location = res.headers.get('Location');
        if (!location?.trim()) {
          throw new FetcherError('Redirect has no Location', res.url, true);
        }
        if (redirects >= MAX_REDIRECTS) {
          throw new FetcherError('Redirect limit exceeded', res.url, true);
        }
        const nextURL = parseHTTPURL(location, currentURL);
        if (currentURL.protocol === 'https:' && nextURL.protocol === 'http:') {
          throw new FetcherError('Refusing HTTPS to HTTP redirect', res.url, true);
        }
        useCookie = useCookie && nextURL.origin === this.#cookieOrigin;
        this.log('debug', `HTTP Redirect: "${request.url}" -> "${nextURL}"`);
        currentURL = nextURL;
      }
      catch (error) {
        (res.body as Readable | null)?.destroy();
        throw error;
      }
      (res.body as Readable | null)?.destroy();
    }
  }

  #commitDownload(tmpFilePath: string, destFilePath: string) {
    try {
      this.log('debug', `Commit: "${tmpFilePath}" -> "${destFilePath} (filesize: ${fs.lstatSync(tmpFilePath).size} bytes)`);
      fs.renameSync(tmpFilePath, destFilePath);
    }
    finally {
      this.#cleanupDownload(tmpFilePath);
    }
  }

  #cleanupDownload(tmpFilePath: string) {
    try {
      if (fs.existsSync(tmpFilePath)) {
        this.log('debug', `Cleanup "${tmpFilePath}"`);
        fs.unlinkSync(tmpFilePath);
      }
    }
    catch (error) {
      this.log('error', `Cleanup error "${tmpFilePath}":`, error);
    }
  }

  #setHeaders(request: Request, setCookie = true) {
    request.headers.set('User-Agent', USER_AGENT);
    if (this.#cookie && setCookie) {
      try {
        request.headers.set('Cookie', this.#cookie);
      }
      catch {
        // Header validation errors include the rejected value; never log session credentials.
        throw new FetcherError('Invalid cookie header', new URL(request.url).origin, true);
      }
    }
  }

  #assertResponseOK(response: Response | null, originURL: string, requireBody: false): response is Response;
  #assertResponseOK(response: Response | null, originURL: string, requireBody?: true): response is Response & { body: NonNullable<Response['body']> };
  #assertResponseOK(response: Response | null, originURL: string, requireBody = true) {
    if (!response) {
      throw new FetcherError('No response', originURL);
    }
    assertResponseStatus(response.status, response.url || originURL, response.headers.get('cf-mitigated'));
    if (requireBody && !response.body) {
      throw new FetcherError('Empty response body', originURL);
    }
    return true;
  }

  protected log(level: LogLevel, ...msg: Array<any>) {
    commonLog(this.#logger, level, this.name, ...msg);
  }
}
