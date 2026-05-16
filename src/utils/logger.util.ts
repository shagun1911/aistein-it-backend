import fs from 'fs';
import path from 'path';

enum LogLevel {
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  DEBUG = 'DEBUG',
}

const LOGS_DIR = path.join(process.cwd(), 'logs');

class Logger {
  private logsDirReady = false;

  private ensureLogsDir(): void {
    if (this.logsDirReady) return;
    try {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      this.logsDirReady = true;
    } catch (err) {
      console.error('[Logger] Failed to create logs directory:', err);
    }
  }

  private getLogFilePath(): string {
    const date = new Date().toISOString().slice(0, 10);
    return path.join(LOGS_DIR, `${date}.txt`);
  }

  private formatMeta(meta?: unknown): string {
    if (meta === undefined || meta === null || meta === '') return '';
    if (typeof meta === 'string') return ` ${meta}`;
    try {
      return ` ${JSON.stringify(meta)}`;
    } catch {
      return ` ${String(meta)}`;
    }
  }

  private writeToFile(level: LogLevel, timestamp: string, message: string, meta?: unknown): void {
    this.ensureLogsDir();
    if (!this.logsDirReady) return;

    const line = `[${level}] ${timestamp} - ${message}${this.formatMeta(meta)}\n`;

    fs.appendFile(this.getLogFilePath(), line, (err) => {
      if (err) {
        console.error('[Logger] Failed to write log file:', err.message);
      }
    });
  }

  private log(level: LogLevel, message: string, meta?: unknown) {
    const timestamp = new Date().toISOString();

    const colorCode = {
      [LogLevel.INFO]: '\x1b[36m',
      [LogLevel.WARN]: '\x1b[33m',
      [LogLevel.ERROR]: '\x1b[31m',
      [LogLevel.DEBUG]: '\x1b[35m',
    }[level];

    const resetCode = '\x1b[0m';

    console.log(`${colorCode}[${level}]${resetCode} ${timestamp} - ${message}`, meta ?? '');

    this.writeToFile(level, timestamp, message, meta);
  }

  info(message: string, meta?: unknown) {
    this.log(LogLevel.INFO, message, meta);
  }

  warn(message: string, meta?: unknown) {
    this.log(LogLevel.WARN, message, meta);
  }

  error(message: string, meta?: unknown) {
    this.log(LogLevel.ERROR, message, meta);
  }

  debug(message: string, meta?: unknown) {
    if (process.env.NODE_ENV === 'development') {
      this.log(LogLevel.DEBUG, message, meta);
    }
  }
}

export const logger = new Logger();
