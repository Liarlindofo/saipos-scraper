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
 * ÚNICA lógica de localizar o botão de troca de loja no modal.
 * Critério do botão: disabled===false && ng-click contém "changeCurrentStore".
 * text vazio é normal (ícone zmdi-arrow-right).
 *
 * Serializada e injetada no page.evaluate / waitForFunction — um só caminho.
 */
const FIND_STORE_BUTTON_SOURCE = String(function findStoreSelectButton(
  lojaId: number,
  nomeNaTabela: string | null,
): {
  found: boolean;
  reason: string;
  button: HTMLButtonElement | null;
  rowText: string;
  rowHtml: string;
  buttons: Array<{
    tag: string;
    text: string;
    className: string;
    ngClick: string;
    disabled: boolean;
    selectable: boolean;
  }>;
  allRowTexts: string[];
} {
  const idStr = String(lojaId);
  const rows = Array.from(document.querySelectorAll('tr'));
  const allRowTexts: string[] = [];

  const isSelectable = (btn: HTMLButtonElement): boolean => {
    if (btn.disabled) return false;
    const ngClick = btn.getAttribute('ng-click') || '';
    return /changeCurrentStore/i.test(ngClick);
  };

  const describeButtons = (row: Element) =>
    Array.from(row.querySelectorAll('button, a')).map((b) => {
      const btn = b as HTMLButtonElement;
      const ngClick = btn.getAttribute('ng-click') || '';
      return {
        tag: btn.tagName,
        text: (btn.textContent || '').replace(/\s+/g, ' ').trim(),
        className: btn.className || '',
        ngClick,
        disabled: btn.disabled === true,
        selectable: !btn.disabled && /changeCurrentStore/i.test(ngClick),
      };
    });

  const matchRow = (row: Element): 'id' | 'nome' | null => {
    const cells = Array.from(row.querySelectorAll('td'));
    if (cells.length === 0) return null;
    const cellTexts = cells.map((c) =>
      (c.textContent || '').replace(/\s+/g, ' ').trim(),
    );
    if (cellTexts.some((t) => t === idStr)) return 'id';
    if (nomeNaTabela) {
      const rowText = (row.textContent || '').toLowerCase();
      if (rowText.includes(nomeNaTabela.toLowerCase())) return 'nome';
    }
    return null;
  };

  let matched: { row: Element; how: 'id' | 'nome' } | null = null;

  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll('td'));
    if (cells.length === 0) continue;
    const text = (row.textContent || '').replace(/\s+/g, ' ').trim();
    allRowTexts.push(text);

    const how = matchRow(row);
    if (!how) continue;
    // Prefere match por ID; se já temos id, para. Se só nome, guarda e continua
    // procurando ID.
    if (how === 'id') {
      matched = { row, how };
      break;
    }
    if (!matched) matched = { row, how };
  }

  if (!matched) {
    return {
      found: false,
      reason: 'row-not-found',
      button: null,
      rowText: '',
      rowHtml: '',
      buttons: [],
      allRowTexts,
    };
  }

  const buttons = describeButtons(matched.row);
  const selectable = Array.from(matched.row.querySelectorAll('button')).find((b) =>
    isSelectable(b as HTMLButtonElement),
  ) as HTMLButtonElement | undefined;

  if (!selectable) {
    return {
      found: true,
      reason: `${matched.how}-row-found-but-no-valid-button`,
      button: null,
      rowText: (matched.row.textContent || '').replace(/\s+/g, ' ').trim(),
      rowHtml: (matched.row as HTMLElement).outerHTML.slice(0, 4000),
      buttons,
      allRowTexts,
    };
  }

  return {
    found: true,
    reason: `${matched.how}:changeCurrentStore`,
    button: selectable,
    rowText: (matched.row.textContent || '').replace(/\s+/g, ' ').trim(),
    rowHtml: (matched.row as HTMLElement).outerHTML.slice(0, 4000),
    buttons,
    allRowTexts,
  };
});

type FindResult = {
  found: boolean;
  reason: string;
  rowText: string;
  rowHtml: string;
  buttons: Array<{
    tag: string;
    text: string;
    className: string;
    ngClick: string;
    disabled: boolean;
    selectable: boolean;
  }>;
  allRowTexts: string[];
  clicked: boolean;
};

/**
 * Espera a linha/botão aparecer e clica — sempre via FIND_STORE_BUTTON_SOURCE.
 */
async function waitAndClickStoreButton(
  page: Page,
  lojaId: number,
  nomeNaTabela: string | undefined,
): Promise<FindResult> {
  // Aguarda o botão válido existir (evita race: modal aberto, tabela ainda vazia)
  try {
    await page.waitForFunction(
      (finderSrc, id, nome) => {
        // eslint-disable-next-line no-new-func
        const find = new Function(`return (${finderSrc})`)() as (
          lojaId: number,
          nomeNaTabela: string | null,
        ) => { found: boolean; button: HTMLButtonElement | null; reason: string };
        const r = find(id, nome);
        return Boolean(r.found && r.button);
      },
      { timeout: config.selectorTimeoutMs },
      FIND_STORE_BUTTON_SOURCE,
      lojaId,
      nomeNaTabela ?? null,
    );
  } catch {
    // Cai no evaluate abaixo pra montar dump com a mesma função
  }

  return page.evaluate(
    (finderSrc, id, nome) => {
      // eslint-disable-next-line no-new-func
      const find = new Function(`return (${finderSrc})`)() as (
        lojaId: number,
        nomeNaTabela: string | null,
      ) => {
        found: boolean;
        reason: string;
        button: HTMLButtonElement | null;
        rowText: string;
        rowHtml: string;
        buttons: Array<{
          tag: string;
          text: string;
          className: string;
          ngClick: string;
          disabled: boolean;
          selectable: boolean;
        }>;
        allRowTexts: string[];
      };

      const r = find(id, nome);
      let clicked = false;
      if (r.button) {
        r.button.click();
        clicked = true;
      }

      return {
        found: r.found,
        reason: r.reason,
        rowText: r.rowText,
        rowHtml: r.rowHtml,
        buttons: r.buttons,
        allRowTexts: r.allRowTexts,
        clicked,
      };
    },
    FIND_STORE_BUTTON_SOURCE,
    lojaId,
    nomeNaTabela ?? null,
  );
}

/**
 * Troca o contexto da loja no painel Saipos.
 * Um único caminho pra achar/clicar o botão (waitAndClickStoreButton).
 */
export async function switchStore(page: Page, opts: SwitchStoreOpts): Promise<void> {
  const { lojaId, nomeNaTabela } = opts;
  log.info('switchStore', `Trocando para loja ID=${lojaId}`, { nomeNaTabela });

  await dismissAlreadyConnectedModal(page);
  await sleep(800); // header Angular pode demorar um frame a pintar

  const headerBefore = await readCurrentStoreFromHeader(page);

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
  } else {
    log.warn('switchStore', 'Header da loja não identificado — tentando abrir modal mesmo assim');
  }

  const opened = await openStoreModal(page);
  if (!opened) {
    const headerDump = await dumpHeaderDebug(page);
    log.error('switchStore', 'Não abri o modal — dump do topo da página:', headerDump);
    throw new Error(
      'switchStore: não abri o modal de lojas. Procurei botão "Selecionar loja" ' +
        'e o nome abreviado no header — nenhum respondeu. Dump: ' +
        headerDump.summary,
    );
  }

  const modalReady = await waitForStoreModal(page);
  if (!modalReady) {
    const headerDump = await dumpHeaderDebug(page);
    throw new Error(
      'switchStore: modal "Selecione a loja" não apareceu após abrir o seletor. ' +
        `Dump: ${headerDump.summary}`,
    );
  }

  const result = await waitAndClickStoreButton(page, lojaId, nomeNaTabela);

  if (!result.clicked) {
    const summary =
      `found=${result.found} reason=${result.reason} ` +
      `text="${result.rowText.slice(0, 200)}" ` +
      `buttons=${JSON.stringify(result.buttons)} ` +
      `html=${result.rowHtml.slice(0, 800)}` +
      (result.allRowTexts.length
        ? ` rows=${result.allRowTexts.slice(0, 8).join(' || ')}`
        : '');

    log.error('switchStore', 'Falha ao clicar changeCurrentStore — dump (mesma função):', {
      reason: result.reason,
      found: result.found,
      rowText: result.rowText,
      buttons: result.buttons,
      rowHtml: result.rowHtml.slice(0, 1500),
      allRowTexts: result.allRowTexts,
      summary,
    });

    throw new Error(
      `switchStore: loja ID=${lojaId}` +
        (nomeNaTabela ? ` / nome="${nomeNaTabela}"` : '') +
        ` não selecionável (via=${result.reason}). Dump: ${summary}`,
    );
  }

  log.info('switchStore', `Clique no botão changeCurrentStore via ${result.reason}`, {
    rowText: result.rowText.slice(0, 120),
  });

  await page
    .waitForFunction(
      () => {
        const body = document.body?.innerText || '';
        return !/selecione a loja/i.test(body);
      },
      { timeout: 15_000 },
    )
    .catch(() => {
      log.warn('switchStore', 'Modal ainda visível após clique — continuando validação do header');
    });

  await sleep(1000);
  const headerAfter = await waitForStoreSwitch(page, nomeNaTabela, lojaId, headerBefore);

  log.info('switchStore', `Contexto da loja ${lojaId} ativo`, {
    before: headerBefore?.display,
    after: headerAfter?.display,
  });
}

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
        log.info('switchStore', `Header confirma loja alvo: "${current.display}"`, current);
        return current;
      }

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
    const visible = (el: HTMLElement) => el.getClientRects().length > 0;
    const candidates = Array.from(
      document.querySelectorAll('button, a, span, div, md-button, li'),
    ) as HTMLElement[];

    // Prioridade 1: nome abreviado da loja ("Calenza...") — identidade real
    for (const el of candidates) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!visible(el) || !text || text.length > 24) continue;
      if ((/^calenza/i.test(text) || /\.\.\.$/.test(text)) && text.length <= 24) {
        const full = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (full.length > 40) continue;
        const clickable =
          (el.closest('button, a, md-button, [ng-click], [ui-sref]') as HTMLElement | null) ||
          el;
        return {
          display: text,
          title: clickable.getAttribute('title') || '',
          ariaLabel: clickable.getAttribute('aria-label') || '',
          rawText: text,
        };
      }
    }

    // Prioridade 2: "SELECIONAR LOJA" (ainda sem loja)
    for (const el of candidates) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^selecionar loja$/i.test(text) && visible(el)) {
        return { display: text, title: '', ariaLabel: '', rawText: text };
      }
    }

    // Prioridade 3: title com calenza
    for (const el of candidates) {
      if (!visible(el)) continue;
      const title = el.getAttribute('title') || '';
      const aria = el.getAttribute('aria-label') || '';
      if (/calenza/i.test(title) || /calenza/i.test(aria)) {
        return {
          display: title || aria,
          title,
          ariaLabel: aria,
          rawText: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        };
      }
    }

    return null;
  });
}

async function dumpHeaderDebug(page: Page): Promise<{ summary: string; snippets: string[] }> {
  return page.evaluate(() => {
    const snippets: string[] = [];
    const nodes = Array.from(
      document.querySelectorAll('header *, .navbar *, .top-navbar *, md-toolbar *, button, a'),
    ) as HTMLElement[];

    for (const el of nodes) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 80) continue;
      if (el.getClientRects().length === 0) continue;
      const interesting =
        /loja|calenza|selecionar|\.\.\./i.test(text) ||
        /loja|store|company|filial/i.test(el.className || '') ||
        /loja|calenza/i.test(el.getAttribute('title') || '') ||
        /loja|calenza/i.test(el.getAttribute('aria-label') || '') ||
        /changeCurrentStore|selectStore|id_store/i.test(el.getAttribute('ng-click') || '');
      if (!interesting) continue;
      snippets.push(
        `<${el.tagName} class="${el.className}" title="${el.getAttribute('title') || ''}" ` +
          `ng-click="${el.getAttribute('ng-click') || ''}">${text.slice(0, 60)}`,
      );
      if (snippets.length >= 20) break;
    }

    return {
      snippets,
      summary:
        snippets.length > 0
          ? snippets.slice(0, 8).join(' || ')
          : `url=${location.href} bodyTop=${(document.body?.innerText || '').slice(0, 300)}`,
    };
  });
}

function storeIdentityMatches(
  current: HeaderStoreInfo,
  nomeNaTabela: string,
  lojaId: number,
): boolean {
  if (/selecionar loja/i.test(current.display)) return false;
  if (/op[cç][oõ]es da loja/i.test(current.display)) return false;

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

/**
 * Abre o modal de seleção de loja.
 * Com sessão ativa o header costuma ser "Calenza..." — NÃO confundir com
 * "Opções da loja" (menu operacional: reforço, retirada, etc.).
 */
async function openStoreModal(page: Page): Promise<boolean> {
  const clicked = await page.evaluate(() => {
    const visible = (el: HTMLElement) => el.getClientRects().length > 0;
    const ownText = (el: Element) => {
      // texto "próprio" (sem filhos) + fallback curto
      let own = '';
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) own += node.textContent || '';
      }
      own = own.replace(/\s+/g, ' ').trim();
      if (own) return own;
      return (el.textContent || '').replace(/\s+/g, ' ').trim();
    };

    const tryClick = (el: Element): string => {
      const clickable =
        (el.closest('button, a, md-button, [ng-click], [ui-sref]') as HTMLElement | null) ||
        (el as HTMLElement);
      if (!visible(clickable) && !visible(el as HTMLElement)) return '';
      clickable.click();
      return ownText(clickable).slice(0, 60) || ownText(el).slice(0, 60);
    };

    const all = Array.from(
      document.querySelectorAll('button, a, md-button, span, div, [ng-click]'),
    );

    // 1) "SELECIONAR LOJA" (login fresco)
    for (const el of all) {
      const text = ownText(el);
      if (/^selecionar loja$/i.test(text)) {
        const t = tryClick(el);
        if (t) return { ok: true, via: 'selecionar-loja', text: t };
      }
    }

    // 2) Nome abreviado da loja no header ("Calenza...") — este abre o modal certo
    for (const el of all) {
      const text = ownText(el);
      if (!text || text.length > 24) continue;
      if (!/^calenza/i.test(text) && !/\.\.\.$/.test(text)) continue;
      // evita clicar em containers gigantes do menu operacional
      const full = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (full.length > 40) continue;
      const t = tryClick(el);
      if (t) return { ok: true, via: 'header-nome-loja', text: t };
    }

    // 3) title/aria com nome da loja
    for (const el of all) {
      const title = el.getAttribute('title') || '';
      const aria = el.getAttribute('aria-label') || '';
      if (!/calenza/i.test(title) && !/calenza/i.test(aria)) continue;
      const t = tryClick(el);
      if (t) return { ok: true, via: 'header-title', text: t || title || aria };
    }

    return { ok: false, via: '', text: '' };
  });

  if (clicked.ok) {
    log.info('switchStore', `Clique no seletor via ${clicked.via}: "${clicked.text}"`);
    await sleep(600);
    // Se abriu menu intermediário, tenta item "Selecionar/Trocar/Alterar loja"
    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('a, button, md-menu-item, li, span'));
      for (const el of items) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (
          /^(selecionar|trocar|alterar)\s+loja$/i.test(text) ||
          /^selecione a loja$/i.test(text)
        ) {
          const clickable =
            (el.closest('a, button, md-menu-item, [ng-click]') as HTMLElement | null) ||
            (el as HTMLElement);
          clickable.click();
          return;
        }
      }
    });
    await sleep(400);
    return true;
  }

  // Último recurso: "Opções da loja" → submenu de troca
  const viaOpcoes = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('a, button, span, div'));
    for (const el of all) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      // só o link curto, não o container do menu
      if (!/^op[cç][oõ]es da loja$/i.test(text)) continue;
      if (text.length > 30) continue;
      (el as HTMLElement).click();
      return true;
    }
    return false;
  });

  if (viaOpcoes) {
    log.info('switchStore', 'Clique em "Opções da loja" — procurando item de troca no menu');
    await sleep(600);
    const submenu = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('a, button, md-menu-item, li, span'));
      for (const el of items) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (/(selecionar|trocar|alterar)\s+loja/i.test(text) && text.length < 40) {
          const clickable =
            (el.closest('a, button, md-menu-item, [ng-click]') as HTMLElement | null) ||
            (el as HTMLElement);
          clickable.click();
          return text;
        }
      }
      return '';
    });
    if (submenu) {
      log.info('switchStore', `Submenu clicado: "${submenu}"`);
      await sleep(500);
      return true;
    }
    log.warn(
      'switchStore',
      'Menu "Opções da loja" aberto, mas sem item Selecionar/Trocar loja — ' +
        'pode ser o menu operacional (não o modal de lojas)',
    );
  }

  return false;
}

/** Modal de lojas de verdade — NÃO confundir com datepicker/tabelas do relatório. */
async function waitForStoreModal(page: Page): Promise<boolean> {
  try {
    await page.waitForFunction(
      () => {
        const body = document.body?.innerText || '';
        if (/selecione a loja/i.test(body)) return true;
        // Botão válido de troca presente
        return Array.from(document.querySelectorAll('button')).some((b) => {
          const ng = b.getAttribute('ng-click') || '';
          return /changeCurrentStore/i.test(ng) && !b.disabled;
        });
      },
      { timeout: config.selectorTimeoutMs },
    );
    await sleep(400);
    return true;
  } catch {
    return false;
  }
}
