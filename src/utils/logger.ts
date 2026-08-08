function ts(): string {
  return new Date().toISOString();
}

export const log = {
  info(step: string, message: string, extra?: unknown): void {
    if (extra !== undefined) {
      console.log(`[${ts()}] [INFO] [${step}] ${message}`, extra);
    } else {
      console.log(`[${ts()}] [INFO] [${step}] ${message}`);
    }
  },
  warn(step: string, message: string, extra?: unknown): void {
    if (extra !== undefined) {
      console.warn(`[${ts()}] [WARN] [${step}] ${message}`, extra);
    } else {
      console.warn(`[${ts()}] [WARN] [${step}] ${message}`);
    }
  },
  error(step: string, message: string, extra?: unknown): void {
    if (extra !== undefined) {
      console.error(`[${ts()}] [ERROR] [${step}] ${message}`, extra);
    } else {
      console.error(`[${ts()}] [ERROR] [${step}] ${message}`);
    }
  },
};
