import { setTimeout as sleep } from 'timers/promises';
import { AbortError } from 'node-fetch';

// https://stackoverflow.com/questions/57835286/deep-recursive-requiredt-on-specific-properties
export type DeepRequired<T> = {
  [P in keyof T]-?: DeepRequired<T[P]>
}

export type DeepPartial<T> = {
  [P in keyof T]?: DeepPartial<T[P]>
}

// Recursively sets properties of T to U
export type RecursivePropsTo<T, U> =
  T extends object ? { [ P in keyof T ]: RecursivePropsTo<T[P], U> } :
  T extends undefined | null ? never :
  U


export function pickDefined<T>(value1: T | undefined, value2: T): T;
export function pickDefined<T>(value1: T, value2: T | undefined): T;
export function pickDefined(value1: undefined, value2: undefined): undefined;
export function pickDefined<T>(value1?: T, value2?: T): T | undefined;
export function pickDefined<T>(value1?: T, value2?: T) {
  return value1 !== undefined ? value1 : value2;
}

export function normalizeAbortError(error: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return error instanceof AbortError ? error : new AbortError('Operation aborted');
  }
  return error;
}

export async function sleepBeforeExecute<T>(fn: () => Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  try {
    await sleep(ms, undefined, { signal });
    if (signal?.aborted) {
      throw new AbortError('Operation aborted');
    }
    return await fn();
  }
  catch (error) {
    throw normalizeAbortError(error, signal);
  }
}
