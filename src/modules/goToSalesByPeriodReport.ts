import type { Page } from 'puppeteer-core';
import { config } from '../config.js';
import { log } from '../utils/logger.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Navega até Vendas por período.
 * Preferência: hash direta (já validada no scraper legado).
 * Fallback: menu ≡ → Relatórios → "Vendas por período".
 */
export async function goToSalesByPeriodReport(page: Page): Promise<void> {
  log.info('goToReport', 'Navegando para Vendas por período');

  if (/#\/app\/report\/sales-by-period/i.test(page.url())) {
    const ready = await datePickersReady(page);
    if (ready) {
      log.info('goToReport', 'Já na rota sales-by-period');
      return;
    }
  }

  // Navegação direta pela hash (mais estável na SPA Angular)
  await page.goto(`${config.baseUrl}/${config.reportHash}`, {
    waitUntil: 'domcontentloaded',
    timeout: config.navTimeoutMs,
  });
  await sleep(1500);

  const ok = await waitForReportReady(page, 15_000);
  if (ok) {
    log.info('goToReport', 'Relatório carregado via hash', { url: page.url() });
    return;
  }

  log.warn('goToReport', 'Hash direta não mostrou o relatório — tentando menu');
  const viaMenu = await tryMenuNavigation(page);
  if (!viaMenu) {
    throw new Error(
      'goToSalesByPeriodReport: não cheguei em #/app/report/sales-by-period ' +
        'nem encontrei os date pickers / título "Vendas por período".',
    );
  }

  await waitForReportReady(page, config.selectorTimeoutMs);
  log.info('goToReport', 'Relatório carregado via menu', { url: page.url() });
}

async function waitForReportReady(page: Page, timeout: number): Promise<boolean> {
  try {
    await page.waitForFunction(
      () => {
        const hashOk = /#\/app\/report\/sales-by-period/i.test(window.location.hash || '');
        const titleOk = /vendas por per[ií]odo/i.test(document.body?.innerText || '');
        const pickers =
          Boolean(document.querySelector('#datePickerSaipos_3')) ||
          Boolean(
            document.querySelector(
              'input[aria-label="Data inicial"], input[placeholder="Data inicial"]',
            ),
          );
        return (hashOk || titleOk) && pickers;
      },
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
}

async function datePickersReady(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    return (
      Boolean(document.querySelector('#datePickerSaipos_3')) ||
      Boolean(
        document.querySelector(
          'input[aria-label="Data inicial"], input[placeholder="Data inicial"]',
        ),
      )
    );
  });
}

async function tryMenuNavigation(page: Page): Promise<boolean> {
  try {
    await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('button, a, i, span, md-icon'),
      ) as HTMLElement[];
      for (const el of candidates) {
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const text = (el.textContent || '').trim();
        const isMenu =
          aria.includes('menu') ||
          text === '≡' ||
          text === '☰' ||
          text === '...' ||
          text === '⋯';
        if (isMenu && el.offsetParent !== null) {
          const clickable =
            (el.closest('button, a, [ng-click]') as HTMLElement | null) || el;
          clickable.click();
          return;
        }
      }
    });
    await sleep(600);

    const clicked = await page.evaluate(() => {
      const clickByText = (needle: string): boolean => {
        const nodes = Array.from(
          document.querySelectorAll('a, button, span, md-list-item, li, div'),
        ) as HTMLElement[];
        for (const el of nodes) {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (t === needle || t.includes(needle)) {
            const clickable =
              (el.closest(
                'a, button, md-list-item, [ng-click], [ui-sref]',
              ) as HTMLElement | null) || el;
            clickable.click();
            return true;
          }
        }
        return false;
      };
      clickByText('Relatórios');
      return (
        clickByText('Vendas por período') || clickByText('Vendas por periodo')
      );
    });

    if (!clicked) return false;
    await sleep(1200);
    return true;
  } catch (err) {
    log.warn('goToReport', 'Falha na navegação por menu', err);
    return false;
  }
}
