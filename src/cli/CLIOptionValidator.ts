import { CLIOptionParserEntry } from './CLIOptions.js';

export default class CLIOptionValidator {

  static validateRequired(entry?: CLIOptionParserEntry, errMsg?: string) {
    if (entry && entry.value) {
      return entry.value;
    }
    if (errMsg) {
      throw Error(errMsg);
    }
    if (entry) {
      throw Error(`${entry.key} requires a value`);
    }
    throw Error('A required option missing');
  }

  static validateString<T extends string[]>(entry?: CLIOptionParserEntry, ...match: T): T[number] | undefined {
    if (!entry) {
      return undefined;
    }
    const value = entry.value || undefined;
    if (match.length > 0 && value && !match.includes(value)) {
      throw Error(`${entry.key} must be one of ${match.map((m) => `'${m}'`).join(', ')}`);
    }
    return value;
  }

  static validateBoolean(entry?: CLIOptionParserEntry) {
    if (!entry) {
      return undefined;
    }
    const value = entry.value || undefined;
    const trueValues = [ 'yes', '1', ' true' ];
    const falseValues = [ 'no', '0', 'false' ];
    let sanitized: boolean | undefined;
    if (value) {
      if (trueValues.includes(value.toLowerCase())) {
        sanitized = true;
      }
      else if (falseValues.includes(value.toLowerCase())) {
        sanitized = false;
      }
      else {
        const allowedValues = [ ...trueValues, ...falseValues ];
        throw Error(`${entry.key} must be one of ${allowedValues.map((m) => `'${m}'`).join(', ')}; currently '${value}'`);
      }
    }
    else {
      sanitized = undefined;
    }
    return sanitized;
  }

  static validateNumber(entry?: CLIOptionParserEntry, min?: number, max?: number) {
    if (!entry) {
      return undefined;
    }
    const value = entry.value || undefined;
    const sanitized = value ? parseInt(value, 10) : undefined;
    if (sanitized !== undefined) {
      if (isNaN(sanitized)) {
        throw Error(`${entry.key} is not a valid number`);
      }
      else if (min !== undefined && sanitized < min) {
        throw Error(`${entry.key} must not be less than ${min}`);
      }
      else if (max !== undefined && sanitized > max) {
        throw Error(`${entry.key} must not be greater than ${max}`);
      }
    }
    return sanitized;
  }

  static validateFlags(entry?: CLIOptionParserEntry, ...match: string[]): string | undefined {
    if (!entry) {
      return undefined;
    }
    const value = entry.value || undefined;
    if (match.length > 0 && value) {
      let unmatch = value;
      for (const m of match) {
        unmatch = unmatch.replaceAll(m, '');
      }
      if (unmatch.length > 0) {
        throw Error(`${entry.key} contains unknown flag '${unmatch[0]}' (valid flags: ${match.map((m) => `'${m}'`).join(', ')})`);
      }
    }
    return value;
  }
}
