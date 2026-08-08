import type { Page } from 'puppeteer-core';
import { config } from '../config.js';
import { log } from '../utils/logger.js';

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve seletores dos dois campos de data.
 * Os IDs Saipos são incrementais (datePickerSaipos_3, _5, _6…) — não fixar.
 */
async function resolveDateSelectors(page: Page): Promise<{ ini: string; fim: string }> {
  const found = await page.evaluate(() => {
    const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0;

    // 1) Labels clássicos
    for (const lbl of ['Data inicial', 'Data final'] as const) {
      /* checked below in pair */
    }
    const byLabel = (lbl: string): HTMLInputElement | null => {
      const el = document.querySelector(
        `input[aria-label="${lbl}"], input[placeholder="${lbl}"]`,
      ) as HTMLInputElement | null;
      if (el && visible(el)) return el;
      for (const lab of Array.from(document.querySelectorAll('label'))) {
        if (!(lab.textContent || '').includes(lbl)) continue;
        const forId = lab.getAttribute('for');
        if (forId) {
          const input = document.getElementById(forId) as HTMLInputElement | null;
          if (input && visible(input)) return input;
        }
        const next = lab.parentElement?.querySelector('input') as HTMLInputElement | null;
        if (next && visible(next)) return next;
      }
      return null;
    };

    const iniLabeled = byLabel('Data inicial');
    const fimLabeled = byLabel('Data final');
    if (iniLabeled && fimLabeled) {
      iniLabeled.setAttribute('data-saipos-date', 'inicial');
      fimLabeled.setAttribute('data-saipos-date', 'final');
      return {
        ini: 'input[data-saipos-date="inicial"]',
        fim: 'input[data-saipos-date="final"]',
      };
    }

    // 2) IDs conhecidos legados
    const d3 = document.querySelector('#datePickerSaipos_3') as HTMLInputElement | null;
    const d4 = document.querySelector('#datePickerSaipos_4') as HTMLInputElement | null;
    if (d3 && d4 && visible(d3) && visible(d4)) {
      return { ini: '#datePickerSaipos_3', fim: '#datePickerSaipos_4' };
    }

    // 3) Qualquer par visível datePickerSaipos_*
    const saipos = Array.from(
      document.querySelectorAll('input[id^="datePickerSaipos_"]'),
    ).filter(visible) as HTMLInputElement[];
    if (saipos.length >= 2) {
      saipos[0].setAttribute('data-saipos-date', 'inicial');
      saipos[1].setAttribute('data-saipos-date', 'final');
      return {
        ini: 'input[data-saipos-date="inicial"]',
        fim: 'input[data-saipos-date="final"]',
      };
    }

    // 4) placeholder genérico "Selecione a data"
    const genericos = Array.from(
      document.querySelectorAll('input[placeholder="Selecione a data"]'),
    ).filter(visible) as HTMLInputElement[];
    if (genericos.length >= 2) {
      genericos[0].setAttribute('data-saipos-date', 'inicial');
      genericos[1].setAttribute('data-saipos-date', 'final');
      return {
        ini: 'input[data-saipos-date="inicial"]',
        fim: 'input[data-saipos-date="final"]',
      };
    }

    return null;
  });

  if (!found) {
    throw new Error(
      'setDateRange: não encontrei par de campos de data ' +
        '(datePickerSaipos_*, Data inicial/final, ou Selecione a data).',
    );
  }
  return found;
}

async function fillDateInput(page: Page, selector: string, value: string): Promise<void> {
  await page.waitForSelector(selector, { timeout: config.selectorTimeoutMs });

  const applied = await page.$eval(
    selector,
    (el, val) => {
      const input = el as HTMLInputElement;
      input.focus();
      const proto = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      );
      proto?.set?.call(input, '');
      proto?.set?.call(input, val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      return input.value;
    },
    value,
  );

  if ((applied || '').replace(/\D/g, '').length >= 8) {
    return;
  }

  await page.click(selector, { count: 3 });
  await sleep(80);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.type(selector, value, { delay: 40 });
  await page.$eval(selector, (el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  });

  const current = await page.$eval(selector, (el) => (el as HTMLInputElement).value);
  if (current.replace(/\D/g, '').length < 8) {
    throw new Error(
      `setDateRange: valor não aplicado em ${selector}. Esperado "${value}", ficou "${current}"`,
    );
  }
}

/**
 * Preenche Data inicial e Data final no formato dd/MM/yyyy.
 */
export async function setDateRange(
  page: Page,
  dataInicial: string,
  dataFinal: string,
): Promise<void> {
  if (!DATE_RE.test(dataInicial) || !DATE_RE.test(dataFinal)) {
    throw new Error(
      `setDateRange: datas devem estar em dd/MM/yyyy (recebido: ${dataInicial}, ${dataFinal})`,
    );
  }

  log.info('setDateRange', `Definindo período ${dataInicial} → ${dataFinal}`);

  await page
    .waitForFunction(
      () => {
        const saipos = document.querySelectorAll('input[id^="datePickerSaipos_"]');
        const labeled = document.querySelector(
          'input[aria-label="Data inicial"], input[placeholder="Data inicial"], ' +
            'input[placeholder="Selecione a data"]',
        );
        return saipos.length >= 2 || Boolean(labeled);
      },
      { timeout: config.selectorTimeoutMs },
    )
    .catch(() => undefined);

  const { ini: selIni, fim: selFim } = await resolveDateSelectors(page);

  await fillDateInput(page, selIni, dataInicial);
  await fillDateInput(page, selFim, dataFinal);

  log.info('setDateRange', 'Datas preenchidas', { selIni, selFim });
}
