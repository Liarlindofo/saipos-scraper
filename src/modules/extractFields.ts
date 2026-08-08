import type { Page } from 'puppeteer-core';
import type { CampoRequest, FieldValues } from '../types.js';
import { log } from '../utils/logger.js';
import { parseSaiposValue } from '../utils/parseValue.js';

/**
 * Extrai campos do relatório.
 * - Campos gerais/cupons/ticket: pares <strong>label</strong> + .ng-binding
 * - Campos de canal: tabela Canal / Qtde / Valor
 *
 * Comparação de labels é sempre normalizada (trim, colapsa espaços, case-insensitive)
 * — nunca exige igualdade exata de string bruta.
 */
export async function extractFields(
  page: Page,
  campos: CampoRequest[],
): Promise<FieldValues> {
  log.info('extractFields', `Extraindo ${campos.length} campo(s)`);

  const raw = await page.evaluate((camposIn) => {
    const normalizeText = (s: string) =>
      (s || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

    /** Igualdade normalizada, com fallback contains (bidirecional). */
    const labelsMatch = (a: string, b: string): boolean => {
      const na = normalizeText(a);
      const nb = normalizeText(b);
      if (!na || !nb) return false;
      return na === nb || na.includes(nb) || nb.includes(na);
    };

    function extractByStrong(label: string): string | null {
      const strongs = Array.from(document.querySelectorAll('strong'));
      let fuzzy: Element | null = null;

      for (const strong of strongs) {
        const pageLabel = strong.textContent || '';
        const exact = normalizeText(pageLabel) === normalizeText(label);
        const fuzzyOk = labelsMatch(pageLabel, label);
        if (!exact && !fuzzyOk) continue;
        if (!exact) {
          if (!fuzzy) fuzzy = strong;
          continue;
        }
        const value = valueNearStrong(strong, pageLabel);
        if (value !== null) return value;
      }

      // Só usa match parcial se nenhum exact bater
      if (fuzzy) {
        return valueNearStrong(fuzzy, fuzzy.textContent || '');
      }
      return null;
    }

    function valueNearStrong(strong: Element, pageLabel: string): string | null {
      const labelNorm = normalizeText(pageLabel);
      const row = strong.closest('.row');
      if (row) {
        const bindings = Array.from(row.querySelectorAll('.ng-binding'));
        for (const b of bindings) {
          const v = (b.textContent || '').trim();
          if (v && normalizeText(v) !== labelNorm) return v;
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
          if (v && normalizeText(v) !== labelNorm) return v;
          ps = ps.nextElementSibling;
        }
      }
      return null;
    }

    function extractCanal(canal: string, metric: 'qtde' | 'valor'): string | null {
      const tables = Array.from(document.querySelectorAll('table'));

      for (const table of tables) {
        const headerCells = Array.from(table.querySelectorAll('th, thead td')).map((c) =>
          normalizeText(c.textContent || ''),
        );
        const headerText = headerCells.join(' | ');
        const looksLikeCanalTable =
          headerText.includes('canal') &&
          (headerText.includes('qtde') || headerText.includes('valor'));

        const rows = Array.from(table.querySelectorAll('tr'));
        if (!looksLikeCanalTable && rows.length > 0) {
          const first = normalizeText(rows[0].textContent || '');
          if (!(first.includes('canal') && (first.includes('qtde') || first.includes('valor')))) {
            continue;
          }
        }

        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll('td'));
          if (cells.length < 2) continue;
          if (!labelsMatch(cells[0].textContent || '', canal)) continue;
          if (metric === 'qtde') {
            return (cells[1]?.textContent || '').trim() || null;
          }
          return (cells[2]?.textContent || cells[1]?.textContent || '').trim() || null;
        }
      }

      const allRows = Array.from(document.querySelectorAll('tr, .row'));
      for (const row of allRows) {
        if (!labelsMatch(row.textContent || '', canal)) continue;
        // Evita falso positivo: exige que o canal apareça como célula/trecho próprio
        const cells = Array.from(row.querySelectorAll('td, .ng-binding, div'));
        const canalCell = cells.find((c) => labelsMatch(c.textContent || '', canal));
        if (!canalCell) continue;
        const values = cells
          .map((c) => (c.textContent || '').trim())
          .filter((v) => v && !labelsMatch(v, canal));
        if (metric === 'qtde' && values[0]) return values[0];
        if (metric === 'valor' && (values[1] || values[0])) return values[1] || values[0];
      }

      return null;
    }

    const out: Record<string, string | null> = {};
    for (const campo of camposIn) {
      const canalMatchRaw = campo.label.match(/^(.+?)\s*[—–-]\s*(Qtde|Valor)\s*$/i);
      if (canalMatchRaw) {
        const canal = canalMatchRaw[1].trim();
        const metric = canalMatchRaw[2].toLowerCase() === 'valor' ? 'valor' : 'qtde';
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
