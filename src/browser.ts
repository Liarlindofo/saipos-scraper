import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { config } from './config.js';
import { log } from './utils/logger.js';

let browser: Browser | null = null;

const LINUX_CHROME_CANDIDATES = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
];

const WIN_CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
];

function resolveExecutablePath(): string | undefined {
  if (config.executablePath) {
    if (!fs.existsSync(config.executablePath)) {
      throw new Error(
        `PUPPETEER_EXECUTABLE_PATH não encontrado: ${config.executablePath}`,
      );
    }
    return config.executablePath;
  }

  const candidates =
    process.platform === 'win32' ? WIN_CHROME_CANDIDATES : LINUX_CHROME_CANDIDATES;

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      log.info('browser', `Chromium encontrado: ${candidate}`);
      return candidate;
    }
  }

  return undefined;
}

export async function getBrowser(): Promise<Browser> {
  if (browser && browser.connected) return browser;

  fs.mkdirSync(config.userDataDir, { recursive: true });

  const executablePath = resolveExecutablePath();
  if (!executablePath) {
    throw new Error(
      'Nenhum Chromium/Chrome encontrado. Defina PUPPETEER_EXECUTABLE_PATH no .env ' +
        '(na VPS, reutilize o mesmo binário do WPPConnect, ex: /usr/bin/google-chrome-stable).',
    );
  }

  log.info('browser', `Iniciando Puppeteer headless=${config.headless}`, {
    executablePath,
    userDataDir: config.userDataDir,
  });

  browser = await puppeteer.launch({
    headless: config.headless,
    executablePath,
    userDataDir: config.userDataDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--disable-gpu',
      '--window-size=1440,900',
    ],
    defaultViewport: { width: 1440, height: 900 },
  });

  browser.on('disconnected', () => {
    log.warn('browser', 'Browser desconectado');
    browser = null;
  });

  return browser;
}

export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const b = await getBrowser();
  const page = await b.newPage();
  page.setDefaultTimeout(config.selectorTimeoutMs);
  page.setDefaultNavigationTimeout(config.navTimeoutMs);

  try {
    return await fn(page);
  } finally {
    try {
      if (!page.isClosed()) await page.close();
    } catch (err) {
      log.warn('browser', 'Falha ao fechar page', err);
    }
  }
}

export async function closeBrowser(): Promise<void> {
  if (!browser) return;
  try {
    await browser.close();
  } catch (err) {
    log.warn('browser', 'Falha ao fechar browser', err);
  } finally {
    browser = null;
  }
}

/** Remove locks órfãos do Chromium no userDataDir (sem apagar o perfil). */
export function clearChromiumLocks(): void {
  const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
  for (const name of locks) {
    const full = path.join(config.userDataDir, name);
    try {
      if (fs.existsSync(full)) fs.unlinkSync(full);
    } catch {
      // ignore
    }
  }
}
