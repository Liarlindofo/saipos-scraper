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
  /** CNPJ da loja (confirmação pós-troca — o header truncado NÃO serve) */
  cnpj?: string;
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
  const { lojaId, nomeNaTabela, cnpj } = opts;
  log.info('switchStore', `Trocando para loja ID=${lojaId}`, { nomeNaTabela, cnpj });

  await dismissAlreadyConnectedModal(page);
  await sleep(400);

  // Skip só com evidência forte (Angular id ou title/aria).
  // NUNCA pular por CNPJ solto no body — na home aparecem CNPJs de várias lojas.
  const needsStore = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, a')).some((el) =>
      /^selecionar loja$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim()),
    ),
  );
  if (!needsStore) {
    const already = await readCurrentStoreIdentity(page);
    const strong =
      already &&
      (already.source.startsWith('angular') || already.source.startsWith('attr')) &&
      identityMatchesTarget(already, lojaId, nomeNaTabela, cnpj);
    if (strong) {
      log.info('switchStore', `Já no contexto da loja alvo — pulando troca`, already);
      return;
    }
    if (already) {
      log.info('switchStore', 'Loja atual detectada — precisa trocar', already);
    }
  } else {
    log.info('switchStore', 'Header "SELECIONAR LOJA" — troca obrigatória');
  }

  // Home tem o seletor mais estável; na página do relatório "Calenza..."
  // frequentemente abre o menu operacional (frente de caixa) em vez do modal.
  await page.evaluate(() => {
    window.location.hash = '#/app/home';
  });
  await sleep(900);
  await dismissOverlays(page);

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

  // Modal fecha rápido na prática; não ficar 15s+ esperando
  const modalClosed = await page
    .waitForFunction(
      () => !/selecione a loja/i.test(document.body?.innerText || ''),
      { timeout: 5_000 },
    )
    .then(() => true)
    .catch(() => false);

  if (!modalClosed) {
    log.warn('switchStore', 'Modal ainda visível após 5s — seguindo pra confirmação');
  }

  // Confirmação preferida: a linha clicada já traz ID/nome/CNPJ + modal fechou.
  // (O texto do header "Calenza..." NUNCA muda entre lojas — não usar.)
  if (
    modalClosed &&
    rowTextMatchesTarget(result.rowText, lojaId, nomeNaTabela, cnpj)
  ) {
    log.info('switchStore', 'Troca confirmada via linha clicada + modal fechou', {
      rowText: result.rowText.slice(0, 120),
    });
    await dismissOverlays(page);
    log.info('switchStore', `Contexto da loja ${lojaId} ativo`);
    return;
  }

  const confirmed = await confirmStoreSwitch(page, lojaId, nomeNaTabela, cnpj);
  await dismissOverlays(page);
  log.info('switchStore', `Contexto da loja ${lojaId} ativo`, confirmed);
}

/** Fecha menus/dropdowns (ex: "Opções da loja" / frente de caixa) que cobrem o relatório. */
export async function dismissOverlays(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape');
    await sleep(150);
  }
  await page.evaluate(() => {
    const backdrop = document.querySelector(
      '.md-menu-backdrop, .md-dialog-backdrop, .modal-backdrop, .cdk-overlay-backdrop',
    ) as HTMLElement | null;
    backdrop?.click();
  });
  await sleep(200);
}

function rowTextMatchesTarget(
  rowText: string,
  lojaId: number,
  nomeNaTabela?: string,
  cnpj?: string,
): boolean {
  const norm = normalize(rowText);
  if (norm.includes(String(lojaId))) return true;
  if (cnpj && rowText.replace(/\D/g, '').includes(cnpj.replace(/\D/g, ''))) return true;
  if (nomeNaTabela && norm.includes(normalize(nomeNaTabela))) return true;
  return false;
}

interface StoreIdentity {
  source: string;
  storeId: number | null;
  nameHint: string;
  cnpjHint: string;
}

function identityMatchesTarget(
  identity: StoreIdentity,
  lojaId: number,
  nomeNaTabela?: string,
  cnpj?: string,
): boolean {
  if (identity.storeId !== null && identity.storeId === lojaId) return true;

  const hay = normalize(
    [identity.nameHint, identity.cnpjHint].filter(Boolean).join(' | '),
  );
  if (!hay) return false;

  if (cnpj) {
    const cnpjDigits = cnpj.replace(/\D/g, '');
    if (cnpjDigits && hay.replace(/\D/g, '').includes(cnpjDigits)) return true;
    if (hay.includes(normalize(cnpj))) return true;
  }

  if (nomeNaTabela && hay.includes(normalize(nomeNaTabela))) return true;

  if (nomeNaTabela?.includes(' - ')) {
    const suffix = normalize(nomeNaTabela.split(' - ').slice(1).join(' - '));
    if (suffix.length >= 3 && hay.includes(suffix)) return true;
  }

  return false;
}

/**
 * Lê identidade real da loja atual:
 * 1) Angular vm.idCurrentStore / id_store
 * 2) title/aria-label completos (não o texto truncado "Calenza...")
 * 3) CNPJ / nome completo visível no body
 */
async function readCurrentStoreIdentity(page: Page): Promise<StoreIdentity | null> {
  return page.evaluate(() => {
    const result: {
      source: string;
      storeId: number | null;
      nameHint: string;
      cnpjHint: string;
    } = { source: '', storeId: null, nameHint: '', cnpjHint: '' };

    const win = window as unknown as {
      angular?: {
        element: (el: Element) => {
          scope?: () => Record<string, unknown> | undefined;
          injector?: () => { get: (name: string) => unknown };
        };
      };
    };

    // 1) Angular scopes — procura idCurrentStore / id_store
    if (win.angular) {
      const scopes = Array.from(document.querySelectorAll('.ng-scope'));
      for (const el of scopes) {
        try {
          let scope: Record<string, unknown> | undefined | null =
            win.angular.element(el).scope?.() ?? null;
          let depth = 0;
          while (scope && depth < 12) {
            const vm = scope.vm as Record<string, unknown> | undefined;
            const candidates = [
              vm?.idCurrentStore,
              vm?.id_store,
              vm?.idStore,
              scope.idCurrentStore,
              scope.id_store,
            ];
            for (const c of candidates) {
              const n = Number(c);
              if (Number.isFinite(n) && n > 0) {
                result.storeId = n;
                result.source = 'angular:idCurrentStore';
                // tenta nome junto
                const nameCand =
                  (vm?.nameCurrentStore as string) ||
                  (vm?.storeName as string) ||
                  (scope.nameCurrentStore as string) ||
                  '';
                if (nameCand) result.nameHint = String(nameCand);
                return result;
              }
            }
            scope = (scope.$parent as Record<string, unknown> | undefined) ?? null;
            depth += 1;
          }
        } catch {
          // ignore scope access errors
        }
      }
    }

    // 2) title / aria-label com nome completo (não o display truncado)
    const nodes = Array.from(
      document.querySelectorAll('button, a, span, div, md-button, [title], [aria-label]'),
    );
    for (const el of nodes) {
      const title = el.getAttribute('title') || '';
      const aria = el.getAttribute('aria-label') || '';
      const tip = `${title} ${aria}`.trim();
      if (!tip) continue;
      if (/calenzano\s*-\s*/i.test(tip) || /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/.test(tip)) {
        result.source = 'attr:title|aria';
        result.nameHint = tip;
        const m = tip.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
        if (m) result.cnpjHint = m[0];
        return result;
      }
    }

    // body:cnpj propositalmente NÃO é usado pra identidade — na home/listagens
    // aparecem CNPJs de várias lojas e geram falso positivo de "já na loja".
    return null;
  });
}

/**
 * Confirma a troca sem depender do texto truncado do header.
 * Timeout curto (4s) — se não confirmar, segue (o clique já foi no botão certo).
 */
async function confirmStoreSwitch(
  page: Page,
  lojaId: number,
  nomeNaTabela: string | undefined,
  cnpj: string | undefined,
): Promise<StoreIdentity | { source: string; note: string }> {
  const deadline = Date.now() + 4_000;

  while (Date.now() < deadline) {
    const identity = await readCurrentStoreIdentity(page);
    if (identity && identityMatchesTarget(identity, lojaId, nomeNaTabela, cnpj)) {
      log.info('switchStore', 'Troca confirmada', identity);
      return identity;
    }
    await sleep(250);
  }

  const last = await readCurrentStoreIdentity(page);
  log.warn(
    'switchStore',
    'Confirmação em 4s inconclusiva — seguindo (botão changeCurrentStore já clicado)',
    { expectedId: lojaId, nomeNaTabela, cnpj, last },
  );
  return last ?? { source: 'timeout', note: 'sem identidade legível' };
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
  await sleep(500);

  const clicked = await page.evaluate(() => {
    const visible = (el: HTMLElement) => el.getClientRects().length > 0;

    const tryClick = (el: Element): string => {
      const clickable =
        (el.closest('button, a, md-button, [ng-click], [ui-sref]') as HTMLElement | null) ||
        (el as HTMLElement);
      if (!visible(clickable) && !visible(el as HTMLElement)) return '';
      clickable.click();
      return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    };

    const all = Array.from(
      document.querySelectorAll('button, a, md-button, span, div, b, strong, [ng-click]'),
    ) as HTMLElement[];

    // 1) "SELECIONAR LOJA" (login fresco)
    for (const el of all) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^selecionar loja$/i.test(text) && visible(el)) {
        const t = tryClick(el);
        if (t) return { ok: true, via: 'selecionar-loja', text: t };
      }
    }

    // 2) Nó cujo textContent INTEIRO é só o nome truncado ("Calenza...")
    //    — ignora containers grandes do menu operacional
    for (const el of all) {
      if (!visible(el)) continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 4 || text.length > 18) continue;
      if (!/^calenza/i.test(text)) continue;
      const t = tryClick(el);
      if (t) return { ok: true, via: 'header-nome-loja', text: t };
    }

    // 3) title/aria com nome da loja
    for (const el of all) {
      if (!visible(el)) continue;
      const title = el.getAttribute('title') || '';
      const aria = el.getAttribute('aria-label') || '';
      if (!/calenza/i.test(title) && !/calenza/i.test(aria)) continue;
      const t = tryClick(el);
      if (t) return { ok: true, via: 'header-title', text: t || title || aria };
    }

    // 4) TreeWalker: menor nó de texto "Calenza..."
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 4 || text.length > 18) continue;
      if (!/^calenza/i.test(text)) continue;
      const parent = node.parentElement;
      if (!parent || !visible(parent)) continue;
      const t = tryClick(parent);
      if (t) return { ok: true, via: 'header-textnode', text: t };
    }

    return { ok: false, via: '', text: '' };
  });

  if (clicked.ok) {
    log.info('switchStore', `Clique no seletor via ${clicked.via}: "${clicked.text}"`);
    await sleep(700);

    // Às vezes "Calenza..." abre o menu operacional (frente de caixa), não o modal de lojas
    const openedWhat = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      const storeModal =
        /selecione a loja/i.test(body) ||
        Array.from(document.querySelectorAll('button')).some((b) =>
          /changeCurrentStore/i.test(b.getAttribute('ng-click') || ''),
        );
      const opsMenu = /frente de caixa/i.test(body) && /retirada de frente/i.test(body);
      return { storeModal, opsMenu };
    });

    if (openedWhat.storeModal) return true;

    if (openedWhat.opsMenu) {
      log.warn(
        'switchStore',
        'Clique abriu menu operacional (frente de caixa) — fechando e tentando de novo',
      );
      await dismissOverlays(page);
      await sleep(400);
      // tenta de novo: clicar no mesmo seletor às vezes alterna; senão procura outro nó
      const retry = await page.evaluate(() => {
        const visible = (el: HTMLElement) => el.getClientRects().length > 0;
        const nodes = Array.from(
          document.querySelectorAll('button, a, md-button, span'),
        ) as HTMLElement[];
        for (const el of nodes) {
          if (!visible(el)) continue;
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (text.length > 18 || !/^calenza/i.test(text)) continue;
          // preferir botão/link, não span solto dentro do menu ops
          const clickable =
            (el.closest('button, a, md-button') as HTMLElement | null) || el;
          clickable.click();
          return text;
        }
        return '';
      });
      if (retry) {
        log.info('switchStore', `Retry seletor: "${retry}"`);
        await sleep(700);
        const ok = await page.evaluate(
          () =>
            /selecione a loja/i.test(document.body?.innerText || '') ||
            Array.from(document.querySelectorAll('button')).some((b) =>
              /changeCurrentStore/i.test(b.getAttribute('ng-click') || ''),
            ),
        );
        if (ok) return true;
      }
      await dismissOverlays(page);
    } else {
      return true; // assume modal a caminho
    }
  }

  // Último recurso: "Opções da loja" → submenu de troca OU nome da loja no dropdown
  const viaOpcoes = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('a, button, span, div'));
    for (const el of all) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/^op[cç][oõ]es da loja$/i.test(text)) continue;
      if (text.length > 30) continue;
      (el as HTMLElement).click();
      return true;
    }
    return false;
  });

  if (viaOpcoes) {
    log.info('switchStore', 'Clique em "Opções da loja" — procurando troca no menu');
    await sleep(700);
    const submenu = await page.evaluate(() => {
      const items = Array.from(
        document.querySelectorAll('a, button, md-menu-item, li, span, div'),
      );
      for (const el of items) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length > 40) continue;
        if (
          /(selecionar|trocar|alterar)\s+loja/i.test(text) ||
          /^calenza/i.test(text) ||
          /^selecione a loja$/i.test(text)
        ) {
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
      log.info('switchStore', `Item do menu clicado: "${submenu}"`);
      await sleep(500);
      // Se clicou em Calenza... no dropdown, o modal de lojas deve abrir
      return true;
    }
    log.warn(
      'switchStore',
      'Menu "Opções da loja" aberto, sem item de troca — menu operacional',
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
