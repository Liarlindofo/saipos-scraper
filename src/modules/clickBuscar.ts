import type { Page } from 'puppeteer-core';
import { config } from '../config.js';
import { log } from '../utils/logger.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function firstResultFingerprint(page: Page): Promise<string> {
  return page.evaluate(() => {
    const binding = document.querySelector('.ng-binding');
    const strong = document.querySelector('strong');
    const row = document.querySelector('.row .ng-binding');
    return [
      binding?.textContent?.trim() ?? '',
      strong?.textContent?.trim() ?? '',
      row?.textContent?.trim() ?? '',
      document.body?.innerText?.slice(0, 400) ?? '',
    ].join('|');
  });
}

/**
 * Clica no botão "Buscar"/"BUSCAR" e espera os resultados atualizarem.
 */
export async function clickBuscar(page: Page): Promise<void> {
  log.info('clickBuscar', 'Clicando em Buscar');

  const before = await firstResultFingerprint(page);

  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const btn of buttons) {
      const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^buscar$/i.test(text) || /buscar/i.test(text)) {
        btn.click();
        return text;
      }
    }
    return '';
  });

  if (!clicked) {
    throw new Error(
      'clickBuscar: botão com texto "Buscar"/"BUSCAR" não encontrado na página do relatório',
    );
  }

  log.info('clickBuscar', `Botão clicado: "${clicked}"`);

  const changed = await page
    .waitForFunction(
      (prev) => {
        const binding = document.querySelector('.ng-binding');
        const strong = document.querySelector('strong');
        const row = document.querySelector('.row .ng-binding');
        const now = [
          binding?.textContent?.trim() ?? '',
          strong?.textContent?.trim() ?? '',
          row?.textContent?.trim() ?? '',
          document.body?.innerText?.slice(0, 400) ?? '',
        ].join('|');
        return now !== prev && now.length > 0;
      },
      { timeout: Math.min(config.selectorTimeoutMs, 25_000) },
      before,
    )
    .then(() => true)
    .catch(() => false);

  if (changed) {
    log.info('clickBuscar', 'Resultados atualizados (fingerprint mudou)');
  } else {
    log.info('clickBuscar', 'Fingerprint estável — aguardando networkidle');
    try {
      await page.waitForNetworkIdle({
        idleTime: 1000,
        timeout: config.selectorTimeoutMs,
      });
      log.info('clickBuscar', 'networkidle atingido');
    } catch {
      log.warn(
        'clickBuscar',
        'Nem fingerprint nem networkidle confirmaram atualização — aguardo fixo 3s',
      );
      await sleep(3000);
    }
  }

  await sleep(800);
}
