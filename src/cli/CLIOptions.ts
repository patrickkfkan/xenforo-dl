import { DownloaderOptions } from '../lib/DownloaderOptions.js';
import { pickDefined } from '../lib/utils/Misc.js';
import { LogLevel } from '../lib/utils/logging/Logger.js';
import CLIOptionValidator from './CLIOptionValidator.js';
import CommandLineParser from './CommandLineParser.js';
import fs from 'fs';

export interface CLIOptions extends Omit<DownloaderOptions, 'dirStructure' | 'logger'> {
  url: string;
  noPrompt: boolean;
  dirStructure: string;
  logging: {
    level: LogLevel;
    file?: string;
  };
  continue: boolean;
  filterPrefix?: string[];
}

export interface CLIOptionParserEntry {
  key: string;
  value?: string | string[];
}

export function getCLIOptions(): CLIOptions {
  const commandLineOptions = CommandLineParser.parse();

  const dirStructure = CLIOptionValidator.validateFlags(commandLineOptions.dirStructure, 's', 'pl', 'pi', 't', 'a', '-');

  let cookie: string | null = CLIOptionValidator.validateString(commandLineOptions?.request?.cookie) || null;
  if (cookie && fs.existsSync(cookie)) {
    try {
      cookie = fs.readFileSync(cookie, 'utf-8').trim();
    }
    catch {
      throw Error('Unable to read the supplied cookie file');
    }
  }
  else if (!cookie) {
    cookie = process.env.XENFORO_COOKIE?.trim() || process.env.COOKIE?.trim() || null;
    if (!cookie && fs.existsSync('./cookie.txt')) {
      try {
        cookie = fs.readFileSync('./cookie.txt', 'utf-8').trim();
      }
      catch {
        throw Error('Unable to read cookie.txt');
      }
    }
  }
  if (cookie && (cookie.startsWith('#') || cookie.startsWith('{') || cookie.startsWith('[') || (/[\r\n]/).test(cookie) || !cookie.includes('='))) {
    throw Error('Cookie must be a raw request-header value (name=value; other=value), not Netscape/JSON or a missing file path');
  }
  const browser = CLIOptionValidator.validateBoolean(commandLineOptions?.request?.browser);
  const browserChannel = CLIOptionValidator.validateString(commandLineOptions?.request?.browserChannel);
  const browserLogin = CLIOptionValidator.validateBoolean(commandLineOptions?.request?.browserLogin);
  const timeoutValue = CLIOptionValidator.validateString(commandLineOptions?.request?.browserTimeout);
  const browserTimeout = timeoutValue === undefined ? undefined : Number(timeoutValue);
  if (browserTimeout !== undefined && (!Number.isSafeInteger(browserTimeout) || browserTimeout <= 0 || browserTimeout > 2147483647)) {
    throw Error('--browser-timeout must be a positive integer no greater than 2147483647');
  }
  if ((browserLogin || timeoutValue !== undefined || browserChannel !== undefined) && !browser) {
    throw Error('--browser-login, --browser-channel and --browser-timeout require --browser');
  }

  const options: CLIOptions = {
    url: CLIOptionValidator.validateRequired(commandLineOptions.url, 'No target URL specified'),
    outDir: CLIOptionValidator.validateString(commandLineOptions.outDir),
    dirStructure: pickDefined(dirStructure, 'splta'),
    overwrite: CLIOptionValidator.validateBoolean(commandLineOptions.overwrite),
    request: {
      maxRetries: CLIOptionValidator.validateNumber(commandLineOptions?.request?.maxRetries),
      maxConcurrent: CLIOptionValidator.validateNumber(commandLineOptions?.request?.maxConcurrent),
      minTime: {
        page: CLIOptionValidator.validateNumber(commandLineOptions?.request?.minTime?.page),
        attachment: CLIOptionValidator.validateNumber(commandLineOptions?.request?.minTime?.attachment)
      },
      cookie,
      browser,
      browserChannel,
      browserLogin,
      browserTimeout
    },
    noPrompt: CLIOptionValidator.validateBoolean(commandLineOptions.noPrompt) || false,
    logging: {
      level: CLIOptionValidator.validateString(commandLineOptions.logging?.level, 'info', 'debug', 'warn', 'error', 'none') || 'info',
      file: CLIOptionValidator.validateString(commandLineOptions.logging?.file)
    },
    continue: CLIOptionValidator.validateBoolean(commandLineOptions.continue) || false,
    filterPrefix: CLIOptionValidator.validateStringArray(commandLineOptions.filterPrefix as any)
  };

  return options;
}
