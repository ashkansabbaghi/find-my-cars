import type { LogLevel } from "./types.js";

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
};

export interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string, err?: unknown) => void;
}

export function createLogger(module: string, minLevel: LogLevel): Logger {
  const minRank = LEVEL_RANK[minLevel];
  const prefix = `[${module}]`;

  return {
    info(message: string) {
      if (LEVEL_RANK.info <= minRank) {
        console.info(`${prefix} ${message}`);
      }
    },
    warn(message: string) {
      if (LEVEL_RANK.warn <= minRank) {
        console.warn(`${prefix} ${message}`);
      }
    },
    error(message: string, err?: unknown) {
      if (LEVEL_RANK.error <= minRank) {
        if (err !== undefined) {
          console.error(`${prefix} ${message}`, err);
        } else {
          console.error(`${prefix} ${message}`);
        }
      }
    },
  };
}
