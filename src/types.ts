export type LogLevel = "info" | "warn" | "error";

export interface AppConfig {
  telegramBotToken: string;
  telegramChatId: string;
  /** Override Bot API base URL (e.g. Cloudflare Worker proxy). Default: https://api.telegram.org */
  telegramApiRoot: string;
  cronSchedule: string;
  logLevel: LogLevel;
  /** Send a price alert when any row moves at least this many percent since the last report. */
  alertThresholdPercent: number;
  /** Tehran hour (0–23) after which the daily report is sent. */
  dailyReportHour: number;
}
