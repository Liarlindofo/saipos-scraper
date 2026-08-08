import type { Page } from 'puppeteer-core';
import type { CampoRequest, FieldValues } from '../types.js';
import { log } from '../utils/logger.js';
import { parseSaiposValue } from '../utils/parseValue.js';

/**
 * Extrai campos do relatório.
 * - Campos gerais/cupons/ticket: pares <strong>label</strong> + .ng-binding
 * - Campos de canal: tabela Canal / Qtde / Valor
 */
export async function extractFields(
  page: Page,
  campos: CampoRequest[],
): Promise<FieldValues> {
  log.info('extractFields', `Extraindo ${campos.length} campo(s)`);

  const raw = await page.evaluate((camposIn) => {
    const norm = (s: string) =>
      s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

    function extractByStrong(label: string): string | null {
      const target = norm(label);
      const strongs = Array.from(document.querySelectorAll('strong'));

      for (const strong of strongs) {
        const text = norm(strong.textContent || '');
        if (text !== target && !text.includes(target)) continue;

        const row = strong.closest('.row');
        if (row) {
          const bindings = Array.from(row.querySelectorAll('.ng-binding'));
          for (const b of bindings) {
            const v = (b.textContent || '').trim();
            if (v && norm(v) !== text) return v;
          }
          // Estrutura: <div><strong>..</strong></div><div class="ng-binding">VALOR</div>
          const parent = strong.parentElement;
          const sibling = parent?.nextElementSibling;
          if (sibling) {
            const v = (sibling.textContent || '').trim();
            if (v) return v;
          }
        }

        // XPath-like: following sibling do strong
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
            if (v && norm(v) !== text) return v;
            ps = ps.nextElementSibling;
          }
        }
      }
      return null;
    }

    function extractCanal(canal: string, metric: 'qtde' | 'valor'): string | null {
      const target = norm(canal);
      const tables = Array.from(document.querySelectorAll('table'));

      for (const table of tables) {
        const headerCells = Array.from(table.querySelectorAll('th, thead td')).map((c) =>
          norm(c.textContent || ''),
        );
        const headerText = headerCells.join(' | ');
        const looksLikeCanalTable =
          headerText.includes('canal') &&
          (headerText.includes('qtde') || headerText.includes('valor'));

        // Também aceita tabelas sem thead claro se a primeira linha parecer cabeçalho
        const rows = Array.from(table.querySelectorAll('tr'));
        if (!looksLikeCanalTable && rows.length > 0) {
          const first = norm(rows[0].textContent || '');
          if (!(first.includes('canal') && (first.includes('qtde') || first.includes('valor')))) {
            continue;
          }
        }

        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll('td'));
          if (cells.length < 2) continue;
          const canalCell = norm(cells[0].textContent || '');
          if (canalCell !== target && !canalCell.includes(target) && !target.includes(canalCell)) {
            continue;
          }
          if (metric === 'qtde') {
            return (cells[1]?.textContent || '').trim() || null;
          }
          return (cells[2]?.textContent || cells[1]?.textContent || '').trim() || null;
        }
      }

      // Fallback: procura linha genérica com o nome do canal
      const allRows = Array.from(document.querySelectorAll('tr, .row'));
      for (const row of allRows) {
        const text = norm(row.textContent || '');
        if (!text.includes(target)) continue;
        const cells = Array.from(row.querySelectorAll('td, .ng-binding, div'));
        const values = cells
          .map((c) => (c.textContent || '').trim())
          .filter((v) => v && norm(v) !== target);
        if (metric === 'qtde' && values[0]) return values[0];
        if (metric === 'valor' && (values[1] || values[0])) return values[1] || values[0];
      }

      return null;
    }

    const out: Record<string, string | null> = {};
    for (const campo of camposIn) {
      const canalMatch = campo.label.match(/^(.+?)\s*[—–-]\s*(Qtde|Valor)\s*$/i);
      if (canalMatch) {
        const canal = canalMatch[1].trim();
        const metric = canalMatch[2].toLowerCase() === 'valor' ? 'valor' : 'qtde';
        out[campo.key] = extractCanal(canal, metric as 'qtde' | 'valor');
      } else {
        out[campo.key] = extractByStrong(campo.label);
      }
    }
    return out;
  }, campos);

  const result: FieldValues = {};
  for (const campo of campos) {
    const text = raw[campo.key] ?? null;
    if (text === null) {
      log.warn('extractFields', `Campo não encontrado: ${campo.key} ("${campo.label}")`);
      result[campo.key] = null;
    } else {
      result[campo.key] = parseSaiposValue(text);
      log.info('extractFields', `${campo.key} = ${String(result[campo.key])} (raw="${text}")`);
    }
  }

  // Aviso explícito se muitos campos falharam (possível mudança de layout)
  const missing = campos.filter((c) => result[c.key] === null);
  if (missing.length > 0 && missing.length === campos.length) {
    log.warn(
      'extractFields',
      'Nenhum campo foi encontrado. O markup do relatório pode ter mudado — ' +
        'não vou inventar seletores. Verifique o HTML da página.',
    );
  }

  return result;
}
