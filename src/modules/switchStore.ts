import type { Page } from 'puppeteer-core';
import { config } from '../config.js';
import { log } from '../utils/logger.js';
import { dismissAlreadyConnectedModal } from './login.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface SwitchStoreOpts {
  lojaId: number;
  /** Ex: "Calenzano - Ahu" — fallback se o ID não aparecer na tabela */
  nomeNaTabela?: string;
}

/**
 * Troca o contexto da loja no painel Saipos.
 * Abre o modal (botão "Selecionar loja" ou nome abreviado no header),
 * localiza a linha pelo ID (coluna ID) e clica na seta.
 * Fallback: busca pelo nome na tabela (padrão do scraper legado).
 */
export async function switchStore(page: Page, opts: SwitchStoreOpts): Promise<void> {
  const { lojaId, nomeNaTabela } = opts;
  log.info('switchStore', `Trocando para loja ID=${lojaId}`, { nomeNaTabela });

  await dismissAlreadyConnectedModal(page);

  const opened = await openStoreModal(page);
  if (!opened) {
    throw new Error(
      'switchStore: não abri o modal de lojas. Procurei botão "Selecionar loja" ' +
        'e o nome abreviado no header — nenhum respondeu. Preciso do HTML do header.',
    );
  }

  await page.waitForFunction(
    () => {
      const body = document.body?.innerText || '';
      return (
        /selecione a loja/i.test(body) ||
        /selecionar loja/i.test(body) ||
        document.querySelectorAll('table tr td').length > 3
      );
    },
    { timeout: config.selectorTimeoutMs },
  );

  await sleep(800);

  const clicked = await page.evaluate(
    (id, nome) => {
      const idStr = String(id);
      const rows = Array.from(document.querySelectorAll('tr'));

      const clickArrow = (row: Element): string => {
        const arrow =
          row.querySelector(
            'button, a.btn, a[ng-click], button[ng-click], button.md-icon-button',
          ) ||
          row.querySelector(
            'i.fa-arrow-right, i.fa-chevron-right, .fa-arrow-right, .glyphicon-arrow-right',
          );
        if (arrow) {
          const target =
            (arrow.closest('button, a') as HTMLElement | null) || (arrow as HTMLElement);
          target.click();
          return 'arrow';
        }
        (row as HTMLElement).click();
        return 'row';
      };

      // 1) Por ID na coluna
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length === 0) continue;
        const texts = cells.map((c) => (c.textContent || '').trim());
        if (texts.some((t) => t === idStr)) {
          return { ok: true, via: `id:${clickArrow(row)}` };
        }
      }

      // 2) Por nome na tabela
      if (nome) {
        const nomeNorm = nome.toLowerCase();
        for (const row of rows) {
          const rowText = (row.textContent || '').toLowerCase();
          if (!rowText.includes(nomeNorm)) continue;
          // evita clicar no header
          if (!row.querySelector('td')) continue;
          return { ok: true, via: `nome:${clickArrow(row)}` };
        }
      }

      return { ok: false, via: '' };
    },
    lojaId,
    nomeNaTabela ?? null,
  );

  if (!clicked.ok) {
    throw new Error(
      `switchStore: loja ID=${lojaId}` +
        (nomeNaTabela ? ` / nome="${nomeNaTabela}"` : '') +
        ' não encontrada no modal. Confirme IDs/nomes no painel Saipos.',
    );
  }

  log.info('switchStore', `Loja selecionada via ${clicked.via}`);

  await page
    .waitForFunction(
      () => {
        const body = document.body?.innerText || '';
        return !/selecione a loja/i.test(body);
      },
      { timeout: config.selectorTimeoutMs },
    )
    .catch(() => {
      log.warn('switchStore', 'Modal ainda visível após seleção — continuando');
    });

  await sleep(1500);
  log.info('switchStore', `Contexto da loja ${lojaId} ativo`);
}

async function openStoreModal(page: Page): Promise<boolean> {
  // Preferência: botão explícito "Selecionar loja" / "SELECIONAR LOJA"
  const byLabel = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, a'));
    for (const el of buttons) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (/selecionar loja/i.test(text) && (el as HTMLElement).offsetParent !== null) {
        (el as HTMLElement).click();
        return true;
      }
    }
    return false;
  });
  if (byLabel) {
    log.info('switchStore', 'Abriu modal via botão "Selecionar loja"');
    return true;
  }

  // Fallback: nome abreviado no header (ex: "CALENZA...")
  const byHeader = await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll('button, a, span, div'),
    ) as HTMLElement[];

    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      if (!text || text.length > 40) continue;
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const title = (el.getAttribute('title') || '').toLowerCase();
      const cls = (el.className || '').toString().toLowerCase();
      const looksLike =
        aria.includes('loja') ||
        title.includes('loja') ||
        cls.includes('store') ||
        cls.includes('company') ||
        cls.includes('filial') ||
        /\.\.\.$/.test(text);

      if (looksLike && el.offsetParent !== null) {
        const clickable =
          (el.closest('button, a, [ng-click], [ui-sref]') as HTMLElement | null) || el;
        clickable.click();
        return text;
      }
    }
    return '';
  });

  if (byHeader) {
    log.info('switchStore', `Abriu modal via header: "${byHeader}"`);
    return true;
  }

  return false;
}
