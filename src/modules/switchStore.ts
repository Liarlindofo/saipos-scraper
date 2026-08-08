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
 * Se já estiver na loja alvo (header), pula a troca.
 * Senão abre o modal, localiza a linha pelo ID e clica na seta.
 */
export async function switchStore(page: Page, opts: SwitchStoreOpts): Promise<void> {
  const { lojaId, nomeNaTabela } = opts;
  log.info('switchStore', `Trocando para loja ID=${lojaId}`, { nomeNaTabela });

  await dismissAlreadyConnectedModal(page);

  // 1) Já estamos no contexto certo? Não abre modal.
  if (nomeNaTabela) {
    const current = await readCurrentStoreFromHeader(page);
    if (current && storeIdentityMatches(current, nomeNaTabela, lojaId)) {
      log.info(
        'switchStore',
        `Já no contexto da loja alvo — pulando troca (header="${current.display}")`,
        current,
      );
      return;
    }
    if (current) {
      log.info('switchStore', `Loja atual no header: "${current.display}" — precisa trocar`, current);
    }
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

      const clickArrow = (row: Element): { via: string; hadButton: boolean } => {
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
          return { via: 'arrow', hadButton: true };
        }
        (row as HTMLElement).click();
        return { via: 'row-click-fallback', hadButton: false };
      };

      // 1) Por ID na coluna
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length === 0) continue;
        const texts = cells.map((c) => (c.textContent || '').trim());
        if (texts.some((t) => t === idStr)) {
          const r = clickArrow(row);
          return { ok: true, via: `id:${r.via}`, hadButton: r.hadButton };
        }
      }

      // 2) Por nome na tabela
      if (nome) {
        const nomeNorm = nome.toLowerCase();
        for (const row of rows) {
          const rowText = (row.textContent || '').toLowerCase();
          if (!rowText.includes(nomeNorm)) continue;
          if (!row.querySelector('td')) continue;
          const r = clickArrow(row);
          return { ok: true, via: `nome:${r.via}`, hadButton: r.hadButton };
        }
      }

      return { ok: false, via: '', hadButton: false };
    },
    lojaId,
    nomeNaTabela ?? null,
  );

  if (!clicked.ok) {
    const dump = await dumpMatchingRow(page, lojaId, nomeNaTabela);
    log.error(
      'switchStore',
      `Loja não selecionável no modal. Dump da linha (ID=${lojaId}):`,
      dump,
    );
    throw new Error(
      `switchStore: loja ID=${lojaId}` +
        (nomeNaTabela ? ` / nome="${nomeNaTabela}"` : '') +
        ' não encontrada/selecionável no modal. ' +
        `Dump da linha: ${dump.summary}`,
    );
  }

  if (!clicked.hadButton) {
    log.warn(
      'switchStore',
      'Linha encontrada sem botão de seta — cliquei na linha inteira (fallback). ' +
        'Se a loja atual não tiver seta por já estar selecionada, o skip do header deveria ter pegado isso.',
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

interface HeaderStoreInfo {
  display: string;
  title: string;
  ariaLabel: string;
  rawText: string;
}

/**
 * Lê o botão/nome da loja atual no header (texto abreviado, title, aria-label).
 */
async function readCurrentStoreFromHeader(page: Page): Promise<HeaderStoreInfo | null> {
  return page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll('button, a, span, div'),
    ) as HTMLElement[];

    for (const el of candidates) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 60) continue;

      // "SELECIONAR LOJA" = nenhuma loja ativa ainda
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

      // Preferir o elemento clicável do header com atributos mais ricos
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

/**
 * Compara header atual com a loja alvo.
 * Não aceita só "Calenzano"/"CALENZA..." — exige o sufixo distintivo (Ahu, Portão…).
 */
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

  // Nome completo no title/aria/texto
  if (haystack.includes(target)) return true;

  // ID explícito em algum atributo/texto
  if (haystack.includes(String(lojaId))) return true;

  // Sufixo distintivo após " - " (ex: "Ahu", "Pilarzinho", "Portão", "Uberaba")
  const suffix = nomeNaTabela.includes(' - ')
    ? nomeNaTabela.split(' - ').slice(1).join(' - ')
    : nomeNaTabela;
  const suffixNorm = normalize(suffix);
  if (suffixNorm.length >= 3 && haystack.includes(suffixNorm)) return true;

  // Texto abreviado: só conta se o sufixo distintivo aparecer nele
  // ( "CALENZA..." sozinho NÃO identifica a loja )
  return false;
}

/**
 * Quando a seleção falha: captura HTML/texto da linha do ID (ou do nome) no modal.
 */
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

        const cellTexts = cells.map((c) => (c.textContent || '').trim());
        const byId = cellTexts.some((t) => t === idStr);
        const byNome = nome
          ? text.toLowerCase().includes(nome.toLowerCase())
          : false;

        if (byId || byNome) {
          const buttons = Array.from(row.querySelectorAll('button, a')).map((b) => ({
            tag: b.tagName,
            text: (b.textContent || '').replace(/\s+/g, ' ').trim(),
            className: (b as HTMLElement).className,
            ngClick: b.getAttribute('ng-click') || '',
            disabled: (b as HTMLButtonElement).disabled === true,
          }));

          const html = (row as HTMLElement).outerHTML.slice(0, 4000);
          const summary =
            `found=true text="${text.slice(0, 200)}" ` +
            `buttons=${JSON.stringify(buttons)} ` +
            `html=${html.slice(0, 800)}`;

          return {
            found: true,
            text,
            html,
            summary,
            allRowTexts,
            buttons,
          };
        }
      }

      const summary =
        `found=false — nenhuma <tr> com ID=${idStr}` +
        (nome ? ` nem nome="${nome}"` : '') +
        `. Linhas vistas (${allRowTexts.length}): ${allRowTexts.slice(0, 8).join(' || ')}`;

      return {
        found: false,
        text: '',
        html: '',
        summary,
        allRowTexts,
      };
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
