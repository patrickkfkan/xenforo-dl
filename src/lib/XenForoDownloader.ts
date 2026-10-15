import deepFreeze from 'deep-freeze';
import { DeepRequired } from './utils/Misc.js';
import { DownloaderOptions, getDownloaderConfig } from './DownloaderOptions.js';
import Fetcher, { FetcherError } from './utils/Fetcher.js';
import Logger, { LogLevel, commonLog } from './utils/logging/Logger.js';
import URLHelper from './utils/URLHelper.js';
import Bottleneck from 'bottleneck';
import { AbortError } from 'node-fetch';
import path from 'path';
import sanitizeFilename from 'sanitize-filename';
import { existsSync } from 'fs';
import fse from 'fs-extra';
import Parser from './parsers/Parser.js';
import { Thread, ThreadMessage, ThreadMessageAttachment, ThreadPage } from './entities/Thread.js';
import MessageTemplate from './templates/Message.js';
import { ForumPage } from './entities/Forum.js';
import ThreadHeaderTemplate from './templates/Thread.js';

export type DownloadTargetType = 'thread' | 'forum' | 'unknown';

export interface DownloaderConfig extends DeepRequired<Pick<DownloaderOptions,
  'outDir' |
  'dirStructure' |
  'request' |
  'overwrite' |
  'continue' |
  'filterPrefix' |
  'noPrompt'>> {
    targetURL: string;
  }

export interface DownloaderStartParams {
  signal?: AbortSignal;
}

export interface DownloadStats {
  processedForumCount: number;
  processedThreadCount: number;
  processedMessageCount: number;
  skippedExistingAttachmentCount: number;
  downloadedAttachmentCount: number;
  errorCount: number;
}

interface DownloadStatus {
  threadID: number;
  url: string;
  messageID: number;
}

interface DownloadThreadContext {
  continued: boolean;
  continueFromMessageID?: number;
}

export default class XenForoDownloader {

  name = 'XenForoDownloader';

  #fetcher?: Promise<Fetcher | import('./utils/BrowserFetcher.js').default>;
  protected pageFetchLimiter: Bottleneck;
  protected attachmentDownloadLimiter: Bottleneck;
  protected config: deepFreeze.DeepReadonly<DownloaderConfig>;
  protected logger?: Logger | null;
  protected parser: Parser;

  constructor(url: string, options?: DownloaderOptions) {
    this.config = deepFreeze({
      ...getDownloaderConfig(url, options)
    });
    this.pageFetchLimiter = new Bottleneck({
      maxConcurrent: 1,
      minTime: this.config.request.minTime.page
    });
    this.attachmentDownloadLimiter = new Bottleneck({
      maxConcurrent: this.config.request.maxConcurrent,
      minTime: this.config.request.minTime.attachment
    });
    this.logger = options?.logger;
    this.parser = new Parser(this.logger);
  }

  async start(params: DownloaderStartParams = {}): Promise<DownloadStats> {
    const stats: DownloadStats = {
      processedForumCount: 0,
      processedThreadCount: 0,
      processedMessageCount: 0,
      skippedExistingAttachmentCount: 0,
      downloadedAttachmentCount: 0,
      errorCount: 0
    };
    const controller = new AbortController();
    const abort = () => controller.abort();
    params.signal?.addEventListener('abort', abort, { once: true });
    if (params.signal?.aborted) {
      abort();
    }
    let failure: unknown;
    try {
      if (controller.signal.aborted) {
        throw new AbortError('Download aborted');
      }
      await this.#process(this.config.targetURL, stats, controller.signal);
      this.log('info', stats.errorCount === 0 ? 'Download complete' : 'Download incomplete');
    }
    catch (error) {
      failure = error;
      if (error instanceof AbortError || params.signal?.aborted) {
        this.log('info', 'Download aborted');
      }
      else {
        this.log('error', 'Download failed:', error);
        this.#updateStatsOnError(error, stats);
      }
    }
    finally {
      // Cancel executing transport jobs before Bottleneck waits for them to stop.
      abort();
      const close = this.#fetcher?.then((fetcher) => fetcher.close(), () => undefined);
      const stopped = Promise.all([
        this.pageFetchLimiter.stop({ dropErrorMessage: 'LimiterStopOnError', dropWaitingJobs: true }),
        this.attachmentDownloadLimiter.stop({ dropErrorMessage: 'LimiterStopOnError', dropWaitingJobs: true })
      ]);
      try {
        await Promise.all([ close, stopped ]);
      }
      catch (error) {
        failure ??= error;
        this.#updateStatsOnError(error, stats);
      }
      params.signal?.removeEventListener('abort', abort);
      this.log('info', '--------------');
      this.log('info', 'Download stats');
      this.log('info', '--------------');
      this.log('info', `Processed forums: ${stats.processedForumCount}`);
      this.log('info', `Processed threads: ${stats.processedThreadCount}`);
      this.log('info', `Processed messages: ${stats.processedMessageCount}`);
      this.log('info', `Downloaded attachments: ${stats.downloadedAttachmentCount}`);
      this.log('info', `Skipped existing attachments: ${stats.skippedExistingAttachmentCount}`);
      this.log('info', `Errors: ${stats.errorCount}`);
    }
    if (failure) {
      throw failure;
    }
    return stats;
  }

  #updateStatsOnError(error: any, stats: DownloadStats) {
    if (!(error instanceof Error) || error.message !== 'LimiterStopOnError') {
      stats.errorCount++;
    }
  }

  protected log(level: LogLevel, ...msg: any[]) {
    const limiterStopOnError = msg.find((m) => m instanceof Error && m.message === 'LimiterStopOnError');
    if (limiterStopOnError) {
      return;
    }
    commonLog(this.logger, level, this.name, ...msg);
  }

  getConfig() {
    return this.config;
  }

  async #process(url: string, stats: DownloadStats, signal?: AbortSignal) {

    const targetType = URLHelper.getTargetTypeByURL(url);

    switch (targetType) {
      case 'thread':
        await this.#downloadThread(url, stats, signal);
        break;

      case 'forum':
        await this.#downloadForum(url, stats, signal);
        break;

      default:
        await this.#downloadGeneric(url, stats, signal);
    }
  }

  async #downloadThread(url: string, stats: DownloadStats, signal?: AbortSignal, context?: DownloadThreadContext): Promise<void> {
    let threadPage: ThreadPage | null = null;
    this.log('info', `Fetching thread content from "${url}"`);
    try {
      const { html, lastURL } = await this.#fetchPage(url, signal);
      threadPage = this.parser.parseThreadPage(html, lastURL);
      threadPage.url = lastURL;
      if (threadPage) {
        this.log('info', `Fetched "${threadPage.title}" (page ${threadPage.currentPage} / ${threadPage.totalPages})`);

        if (!context?.continued && this.config.continue) {
          const prevDownload = this.#checkPreviousDownload(threadPage, this.#getThreadSavePath(threadPage));
          if (prevDownload) {
            this.log('info', 'Continuing from previous download');
            return await this.#downloadThread(prevDownload.url, stats, signal, { continued: true, continueFromMessageID: prevDownload.messageID });
          }
          this.log('debug', `Previous download not found for "${threadPage.title}"`);
        }

        if (context?.continueFromMessageID) {
          const i = threadPage.messages.findIndex((msg) => msg.id === context.continueFromMessageID);
          if (i < 0) {
            throw new FetcherError('Saved checkpoint message is missing from this thread page', url, true);
          }
          const removed = threadPage.messages.splice(0, i + 1);
          this.log('debug', `Removed ${removed.length} previously downloaded messages from thread`);
          if (threadPage.messages.length === 0) {
            this.log('info', 'No new messages since previous download');
          }
        }

        // Handle attachments without filenames (usually non-images)
        const attachmentsWithoutFilenames = threadPage.messages
          .reduce<ThreadMessageAttachment[]>((result, msg) => {
            const filtered = msg.attachments.filter((attachment) => !attachment.filename);
            result.push(...filtered);
            return result;
          }, []);
        if (attachmentsWithoutFilenames.length > 0) {
          this.log('debug', `${attachmentsWithoutFilenames.length} attachments do not have filenames - obtaining them by HEAD requests`);
          const __setAttachmentFilename = async(attachment: ThreadMessageAttachment) => {
            try {
              const fetcher = await this.getFetcher(signal);
              const filename = await this.attachmentDownloadLimiter.schedule(() => fetcher.fetchFilenameByHeaders({
                url: attachment.url,
                maxRetries: this.config.request.maxRetries,
                retryInterval: this.config.request.minTime.attachment,
                signal
              }));
              attachment.filename = filename || undefined;
              this.log('debug', `Set filename of attachment #${attachment.id} to "${attachment.filename}"`);
            }
            catch (error) {
              if (this.#isErrorNonContinuable(error)) {
                throw error;
              }
              this.log('warn', 'Failed to obtain filename from headers; using attachment ID:', error);
            }
          };
          await Promise.all(attachmentsWithoutFilenames.map((attachment) => __setAttachmentFilename(attachment)));
        }

        this.log('debug', 'Parsed thread page:', {
          'Thread ID': threadPage.id,
          Title: threadPage.title,
          Page: `${threadPage.currentPage} / ${threadPage.totalPages}`,
          Messages: threadPage.messages.length,
          Attachments: threadPage.messages.reduce<number>((c, m) => c + m.attachments.length, 0)
        });

        const threadSavePath = this.#getThreadSavePath(threadPage);
        this.log('info', `Save directory: "${threadSavePath}"`);
        const attachmentSavePath = this.config.dirStructure.attachments ? path.resolve(threadSavePath, 'attachments') : threadSavePath;

        fse.ensureDirSync(threadSavePath);
        const messageFile = this.#createMessageFile(threadPage, threadSavePath, !(context?.continued && context?.continueFromMessageID));

        if (threadPage.messages.length > 0) {
          for (const message of threadPage.messages) {
            const hasAttachments = message.attachments.length > 0;
            if (hasAttachments) {
              this.log('info', `Processing message ${message.index} - ${message.attachments.length} attachments to download`);
            }
            else {
              this.log('info', `Processing message ${message.index}`);
            }
            if (hasAttachments) {
              fse.ensureDirSync(attachmentSavePath);
              await Promise.all(message.attachments.map((attachment) => this.#downloadMessageAttachment(attachment, attachmentSavePath, stats, signal)));

              await Promise.all(message.attachments.map(async (attachment) => {
                if (attachment.mediaUrl) {
                  try {
                    const fetcher = await this.getFetcher(signal);
                    const mediaUrl = attachment.mediaUrl;
                    const { html } = await this.pageFetchLimiter.schedule(() => fetcher.fetchHTML({
                      url: mediaUrl,
                      maxRetries: this.config.request.maxRetries,
                      retryInterval: this.config.request.minTime.page,
                      signal
                    }));
                    attachment.comments = this.parser.parseMediaComments(html);
                    if (attachment.comments.length > 0) {
                      this.log('debug', `Parsed ${attachment.comments.length} comments for attachment ${attachment.filename || attachment.id}`);
                    }
                  }
                  catch (error) {
                    this.log('error', `Failed to fetch attachment comments from ${attachment.mediaUrl}:`, error);
                    throw error;
                  }
                }
              }));
            }
            const previousSize = fse.statSync(messageFile).size;
            try {
              this.#saveMessage(message, messageFile);
              this.#saveDownloadStatus(threadPage, message, threadSavePath);
            }
            catch (error) {
              // Ponytail: rollback covers write failures, not process crashes; add durable offsets for crash-safe resume.
              fse.truncateSync(messageFile, previousSize);
              throw error;
            }
            stats.processedMessageCount++;
          }
        }
      }
    }
    catch (error) {
      if (this.#isErrorNonContinuable(error)) {
        throw error;
      }
      this.log('error', error);
      this.#updateStatsOnError(error, stats);
      return;
    }
    if (threadPage?.nextURL) {
      this.log('info', 'Proceeding to next batch of messages');
      const context = this.config.continue ? { continued: true } : undefined;
      await this.#downloadThread(threadPage.nextURL, stats, signal, context);
    }
    else if (threadPage) {
      this.log('info', `Done downloading thread "${threadPage.title}"`);
      stats.processedThreadCount++;
    }
  }

  async #downloadForum(url: string, stats: DownloadStats, signal?: AbortSignal) {
    let forumPage: ForumPage | null = null;
    this.log('info', `Fetching forum content from "${url}"`);
    try {
      const { html, lastURL } = await this.#fetchPage(url, signal);
      forumPage = this.parser.parseForumPage(html, lastURL);
      if (forumPage) {
        this.log('info', `Fetched "${forumPage.title}" (page ${forumPage.currentPage} / ${forumPage.totalPages})`);
        this.log('debug', 'Parsed forum page:', {
          'Forum ID': forumPage.id,
          Title: forumPage.title,
          Page: `${forumPage.currentPage} / ${forumPage.totalPages}`,
          Subforums: forumPage.subforums.length,
          Threads: forumPage.threads.length
        });
        // Download threads
        if (forumPage.threads.length > 0) {
          let threadsToDownload = forumPage.threads;
          const prefixes = this.config.filterPrefix;
          if (prefixes.length > 0) {
            threadsToDownload = threadsToDownload.filter((t) => t.prefix && prefixes.includes(t.prefix));
          }
          else if (!this.config.noPrompt) {
            const uniquePrefixes = Array.from(new Set(forumPage.threads.map((t) => t.prefix).filter((p) => !!p)));
            if (uniquePrefixes.length > 0) {
              const { default: Enquirer } = await import('enquirer');
              const promptFunc = (Enquirer as any).prompt || new (Enquirer as any)().prompt.bind(new (Enquirer as any)());
              const { selected } = await promptFunc({
                type: 'multiselect',
                name: 'selected',
                message: `Select prefixes to download from page ${forumPage.currentPage} / ${forumPage.totalPages} (Space to select, Enter to confirm):`,
                choices: uniquePrefixes as string[]
              });
              threadsToDownload = threadsToDownload.filter((t) => t.prefix && selected.includes(t.prefix));
            }
          }

          this.log('info', `This page has ${forumPage.threads.length} threads. Filtering selected ${threadsToDownload.length} threads to download.`);
          for (const thread of threadsToDownload) {
            await this.#process(thread.url, stats, signal);
          }
        }
      }
    }
    catch (error) {
      if (this.#isErrorNonContinuable(error)) {
        throw error;
      }
      this.log('error', error);
      this.#updateStatsOnError(error, stats);
    }
    if (forumPage?.nextURL) {
      this.log('info', 'Proceeding to next batch of threads');
      await this.#downloadForum(forumPage.nextURL, stats, signal);
    }
    else if (forumPage) {
      this.log('info', `All threads in "${forumPage.title}" downloaded.`);
      if (forumPage.subforums.length > 0) {
        this.log('info', `Now proceeding to subforums (total ${forumPage.subforums.length})`);
        for (const subforum of forumPage.subforums) {
          this.log('info', `Processing "${subforum.title}"`);
          await this.#downloadForum(subforum.url, stats, signal);
        }
      }
      stats.processedForumCount++;
    }
  }

  async #downloadGeneric(url: string, stats: DownloadStats, signal?: AbortSignal) {
    this.log('info', `Fetching "${url}"`);
    try {
      const { html, lastURL } = await this.#fetchPage(url, signal);
      const page = this.parser.parseGenericPage(html, lastURL);
      if (page) {
        if (page.forums.length > 0) {
          this.log('info', `Found ${page.forums.length} forums on page`);
          for (const forum of page.forums) {
            await this.#process(forum.url, stats, signal);
          }
        }
      }
    }
    catch (error) {
      if (this.#isErrorNonContinuable(error)) {
        throw error;
      }
      this.log('error', error);
      this.#updateStatsOnError(error, stats);
    }
  }

  protected async getFetcher(signal?: AbortSignal) {
    if (!this.#fetcher) {
      this.#fetcher = this.config.request.browser ? (async () => {
        const { default: BrowserFetcher } = await import('./utils/BrowserFetcher.js');
        return BrowserFetcher.getInstance({
          url: this.config.targetURL,
          cookie: this.config.request.cookie,
          timeout: this.config.request.browserTimeout,
          requireLogin: this.config.request.browserLogin,
          channel: this.config.request.browserChannel || undefined,
          signal
        }, this.logger);
      })() : Fetcher.getInstance(this.logger, this.config.request.cookie, new URL(this.config.targetURL).origin);
    }
    return this.#fetcher;
  }

  async #fetchPage(url: string, signal?: AbortSignal) {
    const fetcher = await this.getFetcher(signal);
    return this.pageFetchLimiter.schedule(() => {
      this.log('debug', `Fetch page "${url}"`);
      return fetcher.fetchHTML({
        url,
        maxRetries: this.config.request.maxRetries,
        retryInterval: this.config.request.minTime.page,
        signal
      });
    });
  }

  #isErrorNonContinuable(error: any) {
    return error instanceof AbortError || (error instanceof FetcherError && error.fatal);
  }

  #getThreadSavePath(thread: ThreadPage) {
    const pathParts:string[] = [];
    const __pushPathPart = (title: string, id?: number) => {
      if (id) {
        pathParts.push(sanitizeFilename(`${title}.${id}`));
      }
      else {
        pathParts.push(sanitizeFilename(title));
      }
    };
    if (this.config.dirStructure.site && thread.breadcrumbs[0]?.title) {
      __pushPathPart(thread.breadcrumbs[0].title);
    }
    if (thread.breadcrumbs.length > 1) {
      if (this.config.dirStructure.parentForumsAndSections === 'all') {
        thread.breadcrumbs.forEach((crumb, i) => {
          if (i > 0 && crumb.title) {
            const id = URLHelper.parseForumURL(crumb.url)?.id;
            __pushPathPart(crumb.title, id);
          }
        });
      }
      else if (this.config.dirStructure.parentForumsAndSections === 'immediate') {
        const crumb = thread.breadcrumbs.at(-1);
        if (crumb?.title) {
          const id = URLHelper.parseForumURL(crumb.url)?.id;
          __pushPathPart(crumb.title, id);
        }
      }
    }
    if (this.config.dirStructure.thread && thread.title) {
      __pushPathPart(thread.title, thread.id);
    }
    return path.resolve(this.config.outDir, pathParts.join(path.sep));
  }

  async #downloadMessageAttachment(
    attachment: ThreadMessageAttachment,
    destDir: string,
    stats: DownloadStats,
    signal: AbortSignal | undefined
  ) {
    const filename = this.#getMessageAttachmentFilename(attachment);
    const destPath = path.resolve(destDir, filename);
    if (existsSync(destPath) && !this.config.overwrite) {
      this.log('info', `Skipped existing "${filename}"`);
      stats.skippedExistingAttachmentCount++;
      return Promise.resolve();
    }

    try {
      const fetcher = await this.getFetcher(signal);
      await this.attachmentDownloadLimiter.schedule(() => fetcher.downloadAttachment({
        src: attachment.url,
        dest: destPath,
        maxRetries: this.config.request.maxRetries,
        retryInterval: this.config.request.minTime.attachment,
        signal
      }));
      this.log('info', `Downloaded "${filename}"`);
      stats.downloadedAttachmentCount++;
    }
    catch (error) {
      if (this.#isErrorNonContinuable(error)) {
        throw error;
      }
      this.log('error', `Error downloading "${filename}" from "${attachment.url}": `, error);
      throw error;
    }
  }

  #getMessageAttachmentFilename(attachment: ThreadMessageAttachment) {
    if (attachment.filename) {
      return sanitizeFilename(`attach-${attachment.id} - ${attachment.filename}`);
    }

    return sanitizeFilename(`attach-${attachment.id}-${attachment.index}`);
  }

  #createMessageFile(threadPage: ThreadPage, destDir: string, overwrite = false) {
    const filename = sanitizeFilename(`messages-${threadPage.id}-p${threadPage.currentPage} - ${threadPage.title}.txt`);
    const destPath = path.resolve(destDir, filename);

    if (!overwrite && fse.existsSync(destPath)) {
      return destPath;
    }

    const threadHeader = ThreadHeaderTemplate.format(threadPage);
    fse.writeFileSync(destPath, threadHeader);
    this.log('info', `Created message file "${destPath}"`);
    return destPath;
  }

  #saveMessage(
    message: ThreadMessage,
    file: string
  ) {
    if (!message) {
      return;
    }
    const attachments = message.attachments.map<ThreadMessageAttachment>((attachment) => {
      const filename = this.#getMessageAttachmentFilename(attachment);
      return {...attachment, filename};
    });
    const messageOut = MessageTemplate.format({...message, attachments});
    fse.appendFileSync(file, messageOut);
    this.log('info', `Saved message ${message.index} to "${path.parse(file).base}"`);
  }

  #getDownloadStatusFilePath(thread: Thread, threadSavePath: string) {
    const filename = sanitizeFilename(`.dl-status-${thread.id}`);
    return path.resolve(threadSavePath, filename);
  }

  #checkPreviousDownload(thread: Thread, threadSavePath: string): DownloadStatus | false {
    const file = this.#getDownloadStatusFilePath(thread, threadSavePath);
    if (fse.existsSync(file)) {
      const json = fse.readJSONSync(file);
      if (json.threadID !== thread.id || typeof json.url !== 'string' || !Number.isSafeInteger(json.messageID) || json.messageID <= 0) {
        throw new FetcherError('Saved checkpoint has an invalid thread, URL or message ID', thread.url, true);
      }
      const savedURL = new URL(json.url);
      if (savedURL.origin !== new URL(this.config.targetURL).origin || URLHelper.parseThreadURL(json.url)?.id !== thread.id) {
        throw new FetcherError('Saved checkpoint URL does not match this thread and site', thread.url, true);
      }
      return json;
    }
    return false;
  }

  #saveDownloadStatus(thread: Thread, lastSavedMessage: ThreadMessage, threadSavePath: string) {
    const status: DownloadStatus = {
      threadID: thread.id,
      url: thread.url,
      messageID: lastSavedMessage.id
    };
    const file = this.#getDownloadStatusFilePath(thread, threadSavePath);
    const temporary = `${file}.part`;
    try {
      fse.writeJSONSync(temporary, status);
      fse.renameSync(temporary, file);
      this.log('debug', `Saved download status to "${file}"`);
    }
    finally {
      if (fse.existsSync(temporary)) {
        fse.removeSync(temporary);
      }
    }
  }
}
