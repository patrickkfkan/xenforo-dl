import commandLineArgs from 'command-line-args';
import commandLineUsage from 'command-line-usage';
import { CLIOptionParserEntry, CLIOptions } from './CLIOptions.js';
import { EOL } from 'os';
import { DeepPartial, RecursivePropsTo } from '../lib/utils/Misc.js';
import { getPackageInfo } from '../lib/utils/PackageInfo.js';

export type CommandLineParseResult = RecursivePropsTo<DeepPartial<CLIOptions>, CLIOptionParserEntry>;

const COMMAND_LINE_ARGS = {
  help: 'help',
  url: 'url',
  cookie: 'cookie',
  browser: 'browser',
  browserChannel: 'browser-channel',
  browserLogin: 'browser-login',
  browserTimeout: 'browser-timeout',
  outDir: 'out-dir',
  dirStructure: 'dir-structure',
  overwrite: 'overwrite',
  logLevel: 'log-level',
  logFile: 'log-file',
  maxRetries: 'max-retries',
  maxConcurrent: 'max-concurrent',
  minTimePage: 'min-time-page',
  minTimeAttachment: 'min-time-image',
  noPrompt: 'no-prompt',
  continue: 'continue',
  filterPrefix: 'filter-prefix'
} as const;

const OPT_DEFS = [
  {
    name: COMMAND_LINE_ARGS.help,
    description: 'Display this usage guide',
    alias: 'h',
    type: Boolean
  },
  {
    name: COMMAND_LINE_ARGS.url,
    description: 'URL of content to download',
    type: String,
    defaultOption: true
  },
  {
    name: COMMAND_LINE_ARGS.cookie,
    description: 'Raw Cookie header or path to a file containing it',
    alias: 'k',
    type: String
  },
  {
    name: COMMAND_LINE_ARGS.browser,
    description: 'Use a local headed Chromium session for pages and attachments (Node >=20 required)',
    type: Boolean
  },
  {
    name: COMMAND_LINE_ARGS.browserChannel,
    description: 'Browser channel to launch (e.g. "chrome", "msedge", "chromium"). Requires --browser',
    type: String,
    typeLabel: '<channel>'
  },
  {
    name: COMMAND_LINE_ARGS.browserLogin,
    description: 'Require authenticated XenForo content; allows manual login in the browser. Requires --browser',
    type: Boolean
  },
  {
    name: COMMAND_LINE_ARGS.browserTimeout,
    description: 'Browser operation/login timeout in milliseconds. Default: 120000. Requires --browser',
    type: String,
    typeLabel: '<milliseconds>'
  },
  {
    name: COMMAND_LINE_ARGS.outDir,
    description: 'Path to directory where content is saved. Default: current working directory',
    alias: 'o',
    type: String,
    typeLabel: '<dir>'
  },
  {
    name: COMMAND_LINE_ARGS.dirStructure,
    description: 'Combination of flags controlling the output directory structure of downloaded threads. See "Directory structure flags" section for available flags.',
    alias: 'd',
    type: String,
    typeLabel: '<flags>'
  },
  {
    name: COMMAND_LINE_ARGS.overwrite,
    description: 'Overwrite existing attachment files',
    alias: 'w',
    type: Boolean
  },
  {
    name: COMMAND_LINE_ARGS.logLevel,
    description: 'Log level: \'info\', \'debug\', \'warn\' or \'error\'; set to \'none\' to disable logging. Default: info',
    alias: 'l',
    type: String,
    typeLabel: '<level>'
  },
  {
    name: COMMAND_LINE_ARGS.logFile,
    description: 'Save logs to <path>',
    alias: 's',
    type: String,
    typeLabel: '<path>'
  },
  {
    name: COMMAND_LINE_ARGS.maxRetries,
    description: 'Maximum retry attempts when a download fails. Default: 3',
    alias: 'r',
    type: Number,
    typeLabel: '<number>'
  },
  {
    name: COMMAND_LINE_ARGS.maxConcurrent,
    description: 'Maximum number of concurrent downloads for attachments. Default: 10',
    alias: 'c',
    type: Number,
    typeLabel: '<number>'
  },
  {
    name: COMMAND_LINE_ARGS.minTimePage,
    description: 'Minimum time to wait between page fetch requests. Default: 500',
    alias: 'p',
    type: Number,
    typeLabel: '<milliseconds>'
  },
  {
    name: COMMAND_LINE_ARGS.minTimeAttachment,
    description: 'Minimum time to wait between download requests for attachments. Default: 200',
    alias: 'i',
    type: Number,
    typeLabel: '<milliseconds>'
  },
  {
    name: COMMAND_LINE_ARGS.continue,
    description: 'Continue from previous download',
    type: Boolean
  },
  {
    name: COMMAND_LINE_ARGS.noPrompt,
    description: 'Do not prompt for confirmation to proceed',
    alias: 'y',
    type: Boolean
  },
  {
    name: COMMAND_LINE_ARGS.filterPrefix,
    description: 'Filter threads by given prefixes (e.g. "Đề Thi PE")',
    alias: 'f',
    type: String,
    multiple: true,
    typeLabel: '<prefixes>'
  }
];

export default class CommandLineParser {

  static parse(): CommandLineParseResult {
    const opts = this.#parseArgs();
    const argv = process.argv;

    const __getOptNameUsed = (key: string) => {
      const name = `--${key}`;
      if (argv.includes(name)) {
        return name;
      }
      const alias = OPT_DEFS.find((def) => def.name === key)?.alias;
      if (alias) {
        return `-${alias}`;
      }
      return name;
    };

    const __getValue = (key: typeof COMMAND_LINE_ARGS[keyof typeof COMMAND_LINE_ARGS]): CLIOptionParserEntry | undefined => {
      let value = opts[key];

      const booleanTypeArgs = [
        COMMAND_LINE_ARGS.noPrompt,
        COMMAND_LINE_ARGS.overwrite,
        COMMAND_LINE_ARGS.continue,
        COMMAND_LINE_ARGS.browser,
        COMMAND_LINE_ARGS.browserLogin
      ];
      if (booleanTypeArgs.includes(key as any) && value !== undefined) {
        value = '1';
      }

      if (value === null) {
        throw Error(`Command-line option requires a value for '--${key}'`);
      }
      if ((typeof value === 'string' && value) || typeof value === 'number') {
        return {
          key: __getOptNameUsed(key),
          value: String(value).trim()
        };
      }
      if (Array.isArray(value)) {
        return {
          key: __getOptNameUsed(key),
          value: value as string[]
        };
      }
      return undefined;
    };

    return {
      url: __getValue(COMMAND_LINE_ARGS.url),
      outDir: __getValue(COMMAND_LINE_ARGS.outDir),
      dirStructure: __getValue(COMMAND_LINE_ARGS.dirStructure),
      overwrite: __getValue(COMMAND_LINE_ARGS.overwrite),
      request: {
        maxRetries: __getValue(COMMAND_LINE_ARGS.maxRetries),
        maxConcurrent: __getValue(COMMAND_LINE_ARGS.maxConcurrent),
        minTime: {
          page: __getValue(COMMAND_LINE_ARGS.minTimePage),
          attachment: __getValue(COMMAND_LINE_ARGS.minTimeAttachment)
        },
        cookie: __getValue(COMMAND_LINE_ARGS.cookie),
        browser: __getValue(COMMAND_LINE_ARGS.browser),
        browserChannel: __getValue(COMMAND_LINE_ARGS.browserChannel),
        browserLogin: __getValue(COMMAND_LINE_ARGS.browserLogin),
        browserTimeout: __getValue(COMMAND_LINE_ARGS.browserTimeout)
      },
      continue: __getValue(COMMAND_LINE_ARGS.continue),
      noPrompt: __getValue(COMMAND_LINE_ARGS.noPrompt),
      filterPrefix: __getValue(COMMAND_LINE_ARGS.filterPrefix) as any,
      logging: {
        level: __getValue(COMMAND_LINE_ARGS.logLevel),
        file: __getValue(COMMAND_LINE_ARGS.logFile)
      }
    };
  }

  static showUsage() {
    let opts;
    try {
      opts = this.#parseArgs();
    }
    catch (error) {
      return false;
    }
    if (opts.help) {
      const urlContent = [
        'Download a single thread (messages and attachments):',
        `- <forum_site_url>/threads/<title_slug>.<thread_id>[/page-<num>]${EOL}`,

        'Download all threads in a forum (including subforums):',
        `- <forum_site_url>/forums/<title_slug>.<forum_id>[/page-<num>]${EOL}`,

        `If '/page-<num>' is present in URL, download will begin from the specified page.${EOL}`,

        'For URLs not matching the above patterns, xenforo-dl will scrape for forum links and download from them. It is your responsibility to ensure the given URL is a valid XenForo link.'
      ];
      const dirStructureContent = [
        {
          flag: 's',
          desc: 'Include directory for the forum site.'
        },
        {
          flag: 'pl',
          desc: 'Include directory for each category or forum leading up to the target thread.'
        },
        {
          flag: 'pi',
          desc: 'Include directory for the immediate section or forum containing the target thread.'
        },
        {
          flag: 't',
          desc: 'Include directory for the target thread itself.'
        },
        {
          flag: 'a',
          desc: 'Include directory for attachments.'
        },
        {
          flag: '-',
          desc: 'No directory structure. Everything will be saved directly to --out-dir.'
        }
      ];
      const sections: commandLineUsage.Section[] = [
        {
          header: 'Usage',
          content: 'xenforo-dl [OPTION]... URL'
        },
        {
          header: 'URL',
          content: urlContent.join(EOL)
        },
        {
          header: 'Options',
          optionList: OPT_DEFS,
          hide: 'url'
        },
        {
          header: 'Directory structure flags (--dir-structure)',
          content: 'When downloading a thread, the following flags specify which directory is to be included in the output directory structure:'
        },
        {
          content: dirStructureContent
        },
        {
          content: 'Default: splta'
        },
        {
          header: 'Project home',
          content: '{underline https://github.com/patrickkfkan/xenforo-dl}'
        }
      ];
      const banner = getPackageInfo().banner;
      if (banner) {
        sections.unshift({ header: banner, raw: true });
      }
      const usage = commandLineUsage(sections);
      console.log(usage);

      return true;
    }

    return false;
  }

  static #parseArgs() {
    const opts = commandLineArgs(OPT_DEFS, { stopAtFirstUnknown: true });
    if (opts['_unknown']) {
      const unknownOpt = opts['_unknown'][0];
      throw Error(`Unknown option '${unknownOpt}'`);
    }
    return opts;
  }
}
