import type { Page } from 'puppeteer-core';
import { config } from '../config.js';
import { log } from '../utils/logger.js';
import { dismissAlreadyConnectedModal } from './login.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface SwitchStoreOpts {
  lojaId: number;
  /** Ex: "Calenzano - Ahu" — fallback se o ID não aparecer na tabela */
  nomeNaTabela?: string;
}

/**
 * Troca o contexto da loja no painel Saipos.
 * Botão válido = disabled===false e ng-click contém "changeCurrentStore"
 * (texto vazio é normal — é só o ícone zmdi-arrow-right).
 */
export async function switchStore(page: Page, opts: SwitchStoreOpts): Promise<void> {
  const { lojaId, nomeNaTabela } = opts;
  log.info('switchStore', `Trocando para loja ID=${lojaId}`, { nomeNaTabela });

  await dismissAlreadyConnectedModal(page);

  const headerBefore = await readCurrentStoreFromHeader(page);

  // Já no contexto certo? Não abre modal.
  if (nomeNaTabela && headerBefore && storeIdentityMatches(headerBefore, nomeNaTabela, lojaId)) {
    log.info(
      'switchStore',
      `Já no contexto da loja alvo — pulando troca (header="${headerBefore.display}")`,
      headerBefore,
    );
    return;
  }
  if (headerBefore) {
    log.info(
      'switchStore',
      `Loja atual no header: "${headerBefore.display}" — precisa trocar`,
      headerBefore,
    );
  }

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

      /**
       * Botão selecionável: disabled===false e ng-click com changeCurrentStore.
       * text === '' é NORMAL (ícone zmdi-arrow-right) — não rejeitar por isso.
       */
      const findSelectButton = (row: Element): HTMLButtonElement | null => {
        const buttons = Array.from(row.querySelectorAll('button'));
        for (const btn of buttons) {
          const ngClick = btn.getAttribute('ng-click') || '';
          if (btn.disabled) continue;
          if (!/changeCurrentStore/i.test(ngClick)) continue;
          return btn;
        }
        // Fallback: botão com ícone de seta (mesmo sem ng-click legível)
        for (const btn of buttons) {
          if (btn.disabled) continue;
          if (btn.querySelector('i.zmdi-arrow-right, i.zmdi.zmdi-arrow-right')) {
            return btn;
          }
        }
        return null;
      };

      const tryRow = (
        row: Element,
        via: string,
      ): { ok: true; via: string } | null => {
        const btn = findSelectButton(row);
        if (!btn) return null;
        btn.click();
        return { ok: true, via };
      };

      // 1) Por ID
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length === 0) continue;
        const texts = cells.map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim());
        if (!texts.some((t) => t === idStr || t.includes(idStr))) continue;
        const result = tryRow(row, 'id:changeCurrentStore');
        if (result) return result;
        return {
          ok: false,
          via: 'id-row-found-but-no-valid-button',
        };
      }

      // 2) Por nome
      if (nome) {
        const nomeNorm = nome.toLowerCase();
        for (const row of rows) {
          if (!row.querySelector('td')) continue;
          const rowText = (row.textContent || '').toLowerCase();
          if (!rowText.includes(nomeNorm)) continue;
          const result = tryRow(row, 'nome:changeCurrentStore');
          if (result) return result;
          return {
            ok: false,
            via: 'nome-row-found-but-no-valid-button',
          };
        }
      }

      return { ok: false, via: 'row-not-found' };
    },
    lojaId,
    nomeNaTabela ?? null,
  );

  if (!clicked.ok) {
    const dump = await dumpMatchingRow(page, lojaId, nomeNaTabela);
    log.error(
      'switchStore',
      `Falha ao clicar changeCurrentStore (via=${clicked.via}). Dump:`,
      dump,
    );
    throw new Error(
      `switchStore: loja ID=${lojaId}` +
        (nomeNaTabela ? ` / nome="${nomeNaTabela}"` : '') +
        ` não selecionável (via=${clicked.via}). Dump: ${dump.summary}`,
    );
  }

  log.info('switchStore', `Clique no botão changeCurrentStore via ${clicked.via}`);

  // Espera modal fechar
  await page
    .waitForFunction(
      () => {
        const body = document.body?.innerText || '';
        return !/selecione a loja/i.test(body);
      },
      { timeout: config.selectorTimeoutMs },
    )
    .catch(() => {
      log.warn('switchStore', 'Modal ainda visível após clique — continuando validação do header');
    });

  // Valida que a troca realmente aconteceu
  await sleep(1000);
  const headerAfter = await waitForStoreSwitch(
    page,
    nomeNaTabela,
    lojaId,
    headerBefore,
  );

  log.info('switchStore', `Contexto da loja ${lojaId} ativo`, {
    before: headerBefore?.display,
    after: headerAfter?.display,
  });
}

/**
 * Espera o header refletir a loja alvo (ou pelo menos mudar em relação ao before).
 */
async function waitForStoreSwitch(
  page: Page,
  nomeNaTabela: string | undefined,
  lojaId: number,
  before: HeaderStoreInfo | null,
): Promise<HeaderStoreInfo | null> {
  const deadline = Date.now() + Math.min(config.selectorTimeoutMs, 20_000);

  while (Date.now() < deadline) {
    const current = await readCurrentStoreFromHeader(page);
    if (current) {
      if (nomeNaTabela && storeIdentityMatches(current, nomeNaTabela, lojaId)) {
        log.info(
          'switchStore',
          `Header confirma loja alvo: "${current.display}"`,
          current,
        );
        return current;
      }

      // Se não dá pra confirmar pelo sufixo (header abreviado), aceita mudança de texto
      const beforeDisp = before?.display ?? '';
      if (
        current.display &&
        !/selecionar loja/i.test(current.display) &&
        current.display !== beforeDisp
      ) {
        log.info(
          'switchStore',
          `Header mudou de "${beforeDisp}" → "${current.display}" (troca aceita)`,
          current,
        );
        return current;
      }
    }
    await sleep(400);
  }

  const finalHeader = await readCurrentStoreFromHeader(page);
  log.warn(
    'switchStore',
    'Não confirmei mudança clara no header após changeCurrentStore — seguindo mesmo assim',
    { before, after: finalHeader },
  );
  return finalHeader;
}

interface HeaderStoreInfo {
  display: string;
  title: string;
  ariaLabel: string;
  rawText: string;
}

async function readCurrentStoreFromHeader(page: Page): Promise<HeaderStoreInfo | null> {
  return page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll('button, a, span, div'),
    ) as HTMLElement[];

    for (const el of candidates) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 60) continue;

      if (/selecionar loja/i.test(text)) {
        return {
          display: text,
          title: '',
          ariaLabel: '',
          rawText: text,
        };
      }

      const aria = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const cls = (el.className || '').toString().toLowerCase();
      const looksLike =
        aria.toLowerCase().includes('loja') ||
        title.toLowerCase().includes('loja') ||
        cls.includes('store') ||
        cls.includes('company') ||
        cls.includes('filial') ||
        /\.\.\.$/.test(text) ||
        /^calenza/i.test(text);

      if (!looksLike || el.offsetParent === null) continue;

      const clickable =
        (el.closest('button, a, [ng-click], [ui-sref]') as HTMLElement | null) || el;

      return {
        display: text,
        title: clickable.getAttribute('title') || title,
        ariaLabel: clickable.getAttribute('aria-label') || aria,
        rawText: (clickable.textContent || '').replace(/\s+/g, ' ').trim(),
      };
    }
    return null;
  });
}

function storeIdentityMatches(
  current: HeaderStoreInfo,
  nomeNaTabela: string,
  lojaId: number,
): boolean {
  if (/selecionar loja/i.test(current.display)) return false;

  const haystack = normalize(
    [current.display, current.title, current.ariaLabel, current.rawText].join(' | '),
  );
  const target = normalize(nomeNaTabela);

  if (haystack.includes(target)) return true;
  if (haystack.includes(String(lojaId))) return true;

  const suffix = nomeNaTabela.includes(' - ')
    ? nomeNaTabela.split(' - ').slice(1).join(' - ')
    : nomeNaTabela;
  const suffixNorm = normalize(suffix);
  if (suffixNorm.length >= 3 && haystack.includes(suffixNorm)) return true;

  return false;
}

async function dumpMatchingRow(
  page: Page,
  lojaId: number,
  nomeNaTabela?: string,
): Promise<{ summary: string; text: string; html: string; found: boolean; allRowTexts: string[] }> {
  return page.evaluate(
    (id, nome) => {
      const idStr = String(id);
      const rows = Array.from(document.querySelectorAll('tr'));
      const allRowTexts: string[] = [];

      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length === 0) continue;
        const text = (row.textContent || '').replace(/\s+/g, ' ').trim();
        allRowTexts.push(text);

        const cellTexts = cells.map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim());
        const byId = cellTexts.some((t) => t === idStr || t.includes(idStr));
        const byNome = nome ? text.toLowerCase().includes(nome.toLowerCase()) : false;

        if (byId || byNome) {
          const buttons = Array.from(row.querySelectorAll('button, a')).map((b) => ({
            tag: b.tagName,
            text: (b.textContent || '').replace(/\s+/g, ' ').trim(),
            className: (b as HTMLElement).className,
            ngClick: b.getAttribute('ng-click') || '',
            disabled: (b as HTMLButtonElement).disabled === true,
            selectable:
              !(b as HTMLButtonElement).disabled &&
              /changeCurrentStore/i.test(b.getAttribute('ng-click') || ''),
          }));

          const html = (row as HTMLElement).outerHTML.slice(0, 4000);
          const summary =
            `found=true text="${text.slice(0, 200)}" ` +
            `buttons=${JSON.stringify(buttons)} ` +
            `html=${html.slice(0, 800)}`;

          return { found: true, text, html, summary, allRowTexts, buttons };
        }
      }

      const summary =
        `found=false — nenhuma <tr> com ID=${idStr}` +
        (nome ? ` nem nome="${nome}"` : '') +
        `. Linhas vistas (${allRowTexts.length}): ${allRowTexts.slice(0, 8).join(' || ')}`;

      return { found: false, text: '', html: '', summary, allRowTexts };
    },
    lojaId,
    nomeNaTabela ?? null,
  );
}

async function openStoreModal(page: Page): Promise<boolean> {
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
        /\.\.\.$/.test(text) ||
        /^calenza/i.test(text);

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
