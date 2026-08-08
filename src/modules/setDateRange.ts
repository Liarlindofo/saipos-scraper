import type { Page } from 'puppeteer-core';
import { config } from '../config.js';
import { log } from '../utils/logger.js';

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function resolveDateSelector(
  page: Page,
  kind: 'inicial' | 'final',
): Promise<string> {
  const byId = kind === 'inicial' ? '#datePickerSaipos_3' : '#datePickerSaipos_4';
  const hasId = await page.$(byId);
  if (hasId) return byId;

  const label = kind === 'inicial' ? 'Data inicial' : 'Data final';
  const found = await page.evaluate((lbl) => {
    const byAria = document.querySelector(
      `input[aria-label="${lbl}"], input[placeholder="${lbl}"]`,
    );
    if (byAria) {
      if (byAria.id) return `#${byAria.id}`;
      byAria.setAttribute('data-saipos-date', lbl);
      return `input[data-saipos-date="${lbl}"]`;
    }

    const labels = Array.from(document.querySelectorAll('label'));
    for (const lab of labels) {
      if (!(lab.textContent || '').includes(lbl)) continue;
      const forId = lab.getAttribute('for');
      if (forId && document.getElementById(forId)) return `#${forId}`;
      const next = lab.parentElement?.querySelector('input');
      if (next) {
        next.setAttribute('data-saipos-date', lbl);
        return `input[data-saipos-date="${lbl}"]`;
      }
    }
    return null;
  }, label);

  if (!found) {
    throw new Error(
      `setDateRange: campo "${label}" não encontrado ` +
        `(tentei ${byId}, aria-label/placeholder e <label>).`,
    );
  }
  return found;
}

async function fillDateInput(page: Page, selector: string, value: string): Promise<void> {
  await page.waitForSelector(selector, { timeout: config.selectorTimeoutMs });

  // Preferência: setter nativo + eventos Angular (mais confiável com máscara)
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

  // Fallback: digitação com seleção total
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
 * Preferência: #datePickerSaipos_3 / #datePickerSaipos_4
 * Fallback: aria-label / placeholder "Data inicial|final"
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

  const selIni = await resolveDateSelector(page, 'inicial');
  const selFim = await resolveDateSelector(page, 'final');

  await fillDateInput(page, selIni, dataInicial);
  await fillDateInput(page, selFim, dataFinal);

  log.info('setDateRange', 'Datas preenchidas', { selIni, selFim });
}
