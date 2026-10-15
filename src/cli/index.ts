import { EOL } from 'os';
import PromptSync from 'prompt-sync';
import { CLIOptions, getCLIOptions } from './CLIOptions.js';
import CommandLineParser from './CommandLineParser.js';
import Logger, { commonLog } from '../lib/utils/logging/Logger.js';
import { PackageInfo, getPackageInfo } from '../lib/utils/PackageInfo.js';
import FileLogger from '../lib/utils/logging/FileLogger.js';
import ConsoleLogger from '../lib/utils/logging/ConsoleLogger.js';
import ChainLogger from '../lib/utils/logging/ChainLogger.js';
import XenForoDownloader, { DownloaderConfig } from '../lib/XenForoDownloader.js';
import path from 'path';
import { DownloaderOptions } from '../lib/DownloaderOptions.js';
import fastCopy from 'fast-copy';

export default class XenForoDownloaderCLI {

  #logger: Logger | null;
  #packageInfo: PackageInfo;

  constructor() {
    this.#logger = null;
    this.#packageInfo = getPackageInfo();
  }

  async start() {
    if (CommandLineParser.showUsage()) {
      return this.exit(0);
    }

    if (this.#packageInfo.banner) {
      console.log(`${EOL}${this.#packageInfo.banner}${EOL}`);
    }

    let options;
    try {
      options = getCLIOptions();
    }
    catch (error) {
      console.error(
        'Error processing options: ',
        error instanceof Error ? error.message : error,
        EOL,
        'See usage with \'-h\' option.');
      return this.exit(1);
    }

    const { chainLogger: logger, fileLogger } = this.#createLoggers(options);
    this.#logger = logger;

    const dirStructure: DownloaderOptions['dirStructure'] = {};
    if (options.dirStructure.includes('-')) {
      dirStructure.site = false;
      dirStructure.parentForumsAndSections = 'none';
      dirStructure.thread = false;
      dirStructure.attachments = false;
    }
    else {
      dirStructure.site = options.dirStructure.includes('s');
      dirStructure.parentForumsAndSections =
        options.dirStructure.includes('pl') ? 'all' :
          options.dirStructure.includes('pi') ? 'immediate' :
            'none';
      dirStructure.thread = options.dirStructure.includes('t');
      dirStructure.attachments = options.dirStructure.includes('a');
    }

    // Create downloader
    let downloader;
    try {
      downloader = new XenForoDownloader(options.url, {
        ...options,
        dirStructure,
        logger
      });
    }
    catch (error) {
      commonLog(logger, 'error', null, 'Failed to get downloader instance:', error);
      return this.exit(1);
    }

    if (!downloader) {
      commonLog(logger, 'error', null, 'Failed to get downloader instance (unknown reason)');
      return this.exit(1);
    }

    const downloaderName = downloader.name;
    const displayConfig = this.#getConfigForDisplay(downloader.getConfig() as any);

    if (!options.noPrompt) {
      if (options.logging.level === 'none') {
        console.log('Logging disabled', EOL);
      }
      else {
        console.log(`Log level: ${options.logging.level}`);
        if (fileLogger) {
          console.log(`Log file: ${fileLogger.getConfig().logFilePath}`);
          console.log(EOL);
        }
      }

      console.log(`Created ${downloaderName} instance with config: `, displayConfig, EOL);

      if (!this.#confirmProceed()) {
        console.log('Abort');
        return this.exit(1);
      }
    }
    else {
      commonLog(logger, 'debug', null, `Created ${downloaderName} instance with config: `, displayConfig);
    }

    const abortController = new AbortController();
    const abort = () => abortController.abort();
    process.on('SIGINT', abort);
    let exitCode = 0;
    try {
      const stats = await downloader.start({ signal: abortController.signal });
      exitCode = stats.errorCount > 0 ? 1 : 0;
    }
    catch (error) {
      exitCode = abortController.signal.aborted ? 130 : 1;
      if (exitCode !== 130) {
        commonLog(logger, 'error', null, `${downloaderName} failed:`, error);
      }
    }
    finally {
      process.removeListener('SIGINT', abort);
    }
    return this.exit(exitCode);
  }

  #getConfigForDisplay(config: DownloaderConfig) {
    const disp = fastCopy(config);
    disp.request.cookie = disp.request.cookie ? '<hidden>' : '<none>';
    return disp;
  }

  #confirmProceed(prompt?: PromptSync.Prompt): boolean {
    if (!prompt) {
      prompt = PromptSync({ sigint: true });
    }
    const confirmProceed = prompt('Proceed (Y/n)? ');
    if (!confirmProceed.trim() || confirmProceed.trim().toLowerCase() === 'y') {
      return true;
    }
    else if (confirmProceed.trim().toLowerCase() === 'n') {
      return false;
    }

    return this.#confirmProceed(prompt);
  }

  #createLoggers(options: CLIOptions) {
    // Create console logger
    const consoleLogger = new ConsoleLogger({
      logLevel: options.logging.level
    });

    // Create file logger
    let fileLogger: FileLogger | undefined;
    if (options.logging.file) {
      try {
        fileLogger = new FileLogger({
          logFilePath: path.resolve(options.logging.file),
          logLevel: options.logging.level
        });
      }
      catch (error) {
        console.warn('Failed to create file logger: ', error instanceof Error ? error.message : error);
      }
    }

    // Create chain logger
    const chainLogger = new ChainLogger([ consoleLogger ]);
    if (fileLogger) {
      chainLogger.add(fileLogger);
    }

    return {
      chainLogger,
      consoleLogger,
      fileLogger
    };
  }

  async exit(code?: number) {
    if (this.#logger) {
      await this.#logger.end();
    }
    process.exit(code);
  }
}
