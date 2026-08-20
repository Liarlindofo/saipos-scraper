import type { Page } from 'puppeteer-core';
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
 * Espera até que um label conhecido tenha valor NÃO-VAZIO ao lado no DOM.
 * Fingerprint mudar ≠ conteúdo renderizado — a SPA Angular ainda pode estar pintando.
 */
async function waitForRealMetricValue(
  page: Page,
  timeoutMs = 12_000,
): Promise<boolean> {
  const probeLabels = [
    'Qtde total de pedidos',
    'Quantidade de pedidos',
    'Qtde Entrega',
    'Total dos pedidos',
    'Total Entrega',
  ];

  const ok = await page
    .waitForFunction(
      (labels: string[]) => {
        const normalize = (s: string) =>
          (s || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        const labelsMatch = (a: string, b: string) => {
          const na = normalize(a);
          const nb = normalize(b);
          if (!na || !nb) return false;
          return na === nb || na.includes(nb) || nb.includes(na);
        };

        const valueNearStrong = (strong: Element, pageLabel: string): string | null => {
          const labelNorm = normalize(pageLabel);
          const row = strong.closest('.row');
          if (row) {
            const bindings = Array.from(row.querySelectorAll('.ng-binding'));
            for (const b of bindings) {
              const v = (b.textContent || '').trim();
              if (v && normalize(v) !== labelNorm) return v;
            }
            const parent = strong.parentElement;
            const sibling = parent?.nextElementSibling;
            if (sibling) {
              const v = (sibling.textContent || '').trim();
              if (v) return v;
            }
          }

          let sib: Element | null = strong.nextElementSibling;
          while (sib) {
            const v = (sib.textContent || '').trim();
            if (v) return v;
            sib = sib.nextElementSibling;
          }

          const parent = strong.parentElement;
          if (parent) {
            let ps = parent.nextElementSibling;
            while (ps) {
              const v = (ps.textContent || '').trim();
              if (v && normalize(v) !== labelNorm) return v;
              ps = ps.nextElementSibling;
            }
          }
          return null;
        };

        const strongs = Array.from(document.querySelectorAll('strong'));
        for (const label of labels) {
          for (const strong of strongs) {
            const pageLabel = strong.textContent || '';
            if (!labelsMatch(pageLabel, label)) continue;
            const value = valueNearStrong(strong, pageLabel);
            // Valor real: não vazio. "0" / "R$ 0,00" contam (dia fraco ≠ null).
            if (value && value.trim().length > 0) return true;
          }
        }
        return false;
      },
      { timeout: timeoutMs, polling: 250 },
      probeLabels,
    )
    .then(() => true)
    .catch(() => false);

  if (ok) {
    log.info('clickBuscar', 'Conteúdo real confirmado (métrica com valor não-vazio)');
  } else {
    log.warn(
      'clickBuscar',
      'Timeout aguardando valor real ao lado de métrica conhecida — seguindo mesmo assim',
    );
  }
  return ok;
}

/**
 * Clica no botão "Buscar"/"BUSCAR" e espera os resultados atualizarem de verdade.
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
      { timeout: 8_000 },
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
        idleTime: 800,
        timeout: 10_000,
      });
      log.info('clickBuscar', 'networkidle atingido');
    } catch {
      log.warn(
        'clickBuscar',
        'Nem fingerprint nem networkidle confirmaram atualização — aguardo fixo 1.5s',
      );
      await sleep(1500);
    }
  }

  // Labels sozinhas não bastam — a SPA pode ter pintado o rótulo sem o valor.
  // Só segue quando pelo menos uma métrica conhecida tem valor não-vazio.
  const hasValue = await waitForRealMetricValue(page, 8_000);
  if (!hasValue) {
    log.info('clickBuscar', 'Re-tentando espera de conteúdo real (+4s)');
    await sleep(800);
    await waitForRealMetricValue(page, 4_000);
  }

  await sleep(400);
}
