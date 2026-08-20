import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { log } from './logger.js';

/**
 * Screenshot de debug (mesmo padrão do login).
 * Salva em logs/debug-{tag}-{timestamp}.png
 */
export async function dumpDebugScreenshot(
  page: Page,
  tag: string,
  meta?: Record<string, unknown>,
): Promise<string | null> {
  try {
    const dir = path.resolve('logs');
    fs.mkdirSync(dir, { recursive: true });
    const safe = tag.replace(/[^a-zA-Z0-9_-]+/g, '-');
    const file = path.join(dir, `debug-${safe}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    log.warn('debugScreenshot', `Screenshot: ${file}`, {
      url: page.url(),
      ...meta,
    });
    return file;
  } catch (err) {
    log.warn('debugScreenshot', 'Falha ao salvar screenshot', err);
    return null;
  }
}
