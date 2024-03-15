import util from 'util';
import clc from 'cli-color';
import dateFormat from 'dateformat';
import Logger, { LogEntry, LogLevel } from '../../utils/logging/Logger.js';
import { DeepRequired, pickDefined } from '../Misc.js';

const LOG_LEVEL_ORDER = [
  'error',
  'warn',
  'info',
  'debug'
];

export interface ConsoleLoggerOptions {
  logLevel?: LogLevel;
  include?: {
    dateTime?: boolean;
    level?: boolean;
    originator?: boolean;
    errorStack?: boolean;
  };
  dateTimeFormat?: string;
  color?: boolean;
}

type ConsoleLoggerConfig = DeepRequired<ConsoleLoggerOptions>;

const DEFAULT_LOGGER_CONFIG: ConsoleLoggerConfig = {
  logLevel: 'info',
  include: {
    dateTime: true,
    level: true,
    originator: true,
    errorStack: false
  },
  dateTimeFormat: 'mmm dd HH:MM:ss',
  color: true
};

export default class ConsoleLogger extends Logger {

  protected config: ConsoleLoggerConfig;

  protected static readonly LOG_COLORS: Record<string, clc.Format> = {
    error: clc.red.bold,
    warn: clc.magenta,
    info: clc.green,
    debug: clc.yellow,
    originator: clc.blue
  };

  constructor(options?: ConsoleLoggerOptions) {
    super();
    this.setOptions(options);
  }

  protected setOptions(options?: ConsoleLoggerOptions) {
    this.config = {
      logLevel: pickDefined(options?.logLevel, DEFAULT_LOGGER_CONFIG.logLevel),
      include: {
        dateTime: pickDefined(options?.include?.dateTime, DEFAULT_LOGGER_CONFIG.include.dateTime),
        level: pickDefined(options?.include?.level, DEFAULT_LOGGER_CONFIG.include.level),
        originator: pickDefined(options?.include?.originator, DEFAULT_LOGGER_CONFIG.include.originator),
        errorStack: pickDefined(options?.include?.errorStack, DEFAULT_LOGGER_CONFIG.include.errorStack)
      },
      dateTimeFormat: pickDefined(options?.dateTimeFormat, DEFAULT_LOGGER_CONFIG.dateTimeFormat),
      color: pickDefined(options?.color, DEFAULT_LOGGER_CONFIG.color)
    };
  }

  log(entry: LogEntry): void {
    if (this.config.logLevel === 'none') {
      return;
    }
    if (this.checkLevel(entry.level)) {
      this.toOutput(entry.level, this.toStrings(entry));
    }
  }

  getConfig() {
    return this.config;
  }

  setLevel(value: LogLevel): void {
    this.config.logLevel = value;
  }

  protected checkLevel(targetLevel: LogLevel) {
    return LOG_LEVEL_ORDER.indexOf(targetLevel) <= LOG_LEVEL_ORDER.indexOf(this.config.logLevel);
  }

  protected toStrings(entry: LogEntry): string[] {
    const { level, originator, message } = entry;
    const strings = message.reduce<string[]>((result, m) => {
      if (m instanceof Error) {
        if (m.name !== 'Error') {
          result.push(`(${m.name}) ${m.message}`);
        }
        else {
          result.push(m.message);
        }
        if (m.stack && this.config.include.errorStack) {
          result.push(m.stack);
        }
      }
      else if (typeof m === 'object') {
        result.push(util.inspect(m, false, null, this.config.color));
      }
      else {
        result.push(m);
      }

      return result;
    }, []);

    if (originator && this.config.include.originator) {
      strings.unshift(this.colorize(`${originator}:`, 'originator'));
    }

    if (this.config.include.level) {
      strings.unshift(this.colorize(`${level}:`, level));
    }

    if (this.config.include.dateTime) {
      const dateTimeStr = `${dateFormat(new Date(), this.config.dateTimeFormat)}:`;
      strings.unshift(dateTimeStr);
    }

    return strings;
  }

  protected colorize(value: string, colorKey: string) {
    const formatColor = ConsoleLogger.LOG_COLORS[colorKey];
    if (this.config.color && formatColor) {
      return formatColor(value);
    }
    return value;
  }

  protected toOutput(level: LogLevel, msg: string[]) {
    switch (level) {
      case 'error':
        console.error(...msg);
        break;
      case 'warn':
        console.warn(...msg);
        break;
      case 'info':
        console.info(...msg);
        break;
      case 'debug':
        console.debug(...msg);
        break;
      default:
    }
  }
}
