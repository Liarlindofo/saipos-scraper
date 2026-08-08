import type { Page } from 'puppeteer-core';
import { config } from '../config.js';
import { log } from '../utils/logger.js';
import { dismissOverlays } from './switchStore.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Navega até Vendas por período (após switchStore, tipicamente vindo da home).
 */
export async function goToSalesByPeriodReport(page: Page): Promise<void> {
  log.info('goToReport', 'Navegando para Vendas por período');
  await dismissOverlays(page);

  await page.goto(`${config.baseUrl}/${config.reportHash}`, {
    waitUntil: 'domcontentloaded',
    timeout: config.navTimeoutMs,
  });
  await sleep(1500);
  await dismissOverlays(page);

  try {
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10_000 });
  } catch {
    /* ignore */
  }

  if (await waitForReportReady(page, 15_000)) {
    log.info('goToReport', 'Relatório carregado via hash', { url: page.url() });
    return;
  }

  // Debug: o que tem na página quando pickers faltam
  const debug = await page.evaluate(() => ({
    url: location.href,
    title: /vendas por per[ií]odo/i.test(document.body?.innerText || ''),
    inputs: Array.from(document.querySelectorAll('input'))
      .slice(0, 20)
      .map((i) => ({
        id: i.id,
        aria: i.getAttribute('aria-label'),
        placeholder: i.placeholder,
        type: i.type,
        visible: i.getClientRects().length > 0,
      })),
    bodyHead: (document.body?.innerText || '').slice(0, 500),
  }));
  log.warn('goToReport', 'Pickers ausentes após goto — dump', debug);

  log.warn('goToReport', 'Hash direta não mostrou o relatório — tentando menu');
  const viaMenu = await tryMenuNavigation(page);
  if (!viaMenu) {
    throw new Error(
      'goToSalesByPeriodReport: não cheguei em #/app/report/sales-by-period ' +
        'nem encontrei os date pickers / título "Vendas por período".',
    );
  }

  if (!(await waitForReportReady(page, config.selectorTimeoutMs))) {
    const debug2 = await page.evaluate(() => ({
      url: location.href,
      inputs: Array.from(document.querySelectorAll('input'))
        .slice(0, 20)
        .map((i) => ({
          id: i.id,
          aria: i.getAttribute('aria-label'),
          placeholder: i.placeholder,
        })),
      bodyHead: (document.body?.innerText || '').slice(0, 500),
    }));
    throw new Error(
      'goToSalesByPeriodReport: menu clicou mas date pickers não apareceram. ' +
        JSON.stringify(debug2),
    );
  }
  log.info('goToReport', 'Relatório carregado via menu', { url: page.url() });
}

async function waitForReportReady(page: Page, timeout: number): Promise<boolean> {
  try {
    await page.waitForFunction(
      () => {
        const hashOk = /#\/app\/report\/sales-by-period/i.test(window.location.hash || '');
        const titleOk = /vendas por per[ií]odo/i.test(document.body?.innerText || '');
        // IDs são incrementais (datePickerSaipos_3, _5, _6…) — não fixar _3/_4
        const saiposPickers = Array.from(
          document.querySelectorAll('input[id^="datePickerSaipos_"]'),
        ).filter((el) => (el as HTMLElement).getClientRects().length > 0);
        const labeled = Boolean(
          document.querySelector(
            'input[aria-label="Data inicial"], input[placeholder="Data inicial"], ' +
              'input[placeholder="Selecione a data"]',
          ),
        );
        const pickers = saiposPickers.length >= 2 || labeled;
        return (hashOk || titleOk) && pickers;
      },
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
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
