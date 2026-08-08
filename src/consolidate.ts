import type { CampoRequest, FieldValues } from './types.js';
import { log } from './utils/logger.js';
import {
  isSummableKey,
  TICKET_MEDIO_PAIRS,
} from './utils/parseValue.js';

function asNumber(v: number | string | null | undefined): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Consolida valores das lojas:
 * - qtde_*, total_*, valor_*, canal_*: soma simples
 * - ticket_medio_*: recalcula (soma totais ÷ soma qtdes), nunca média aritmética dos tickets
 */
export function buildConsolidado(
  porLoja: Record<string, FieldValues>,
  campos: CampoRequest[],
): FieldValues {
  const lojaEntries = Object.values(porLoja);
  const consolidado: FieldValues = {};

  for (const campo of campos) {
    const { key } = campo;

    if (key.startsWith('ticket_medio')) {
      consolidado[key] = recalcTicketMedio(key, porLoja, lojaEntries);
      continue;
    }

    if (!isSummableKey(key)) {
      // Campos não numéricos / desconhecidos: null no consolidado
      consolidado[key] = null;
      log.warn('consolidado', `Campo ${key} não é somável — consolidado=null`);
      continue;
    }

    let sum = 0;
    let saw = false;
    for (const values of lojaEntries) {
      const n = asNumber(values[key]);
      if (n === null) continue;
      sum += n;
      saw = true;
    }
    consolidado[key] = saw ? roundMoney(sum) : null;
  }

  return consolidado;
}

function recalcTicketMedio(
  key: string,
  porLoja: Record<string, FieldValues>,
  lojaEntries: FieldValues[],
): number | null {
  const pair = TICKET_MEDIO_PAIRS[key];

  // 1) Preferência: soma(totalKey) / soma(qtdeKey) se ambos existirem nos dados
  if (pair) {
    let sumTotal = 0;
    let sumQtde = 0;
    let sawTotal = false;
    let sawQtde = false;

    for (const values of lojaEntries) {
      const t = asNumber(values[pair.totalKey]);
      const q = asNumber(values[pair.qtdeKey]);
      if (t !== null) {
        sumTotal += t;
        sawTotal = true;
      }
      if (q !== null) {
        sumQtde += q;
        sawQtde = true;
      }
    }

    if (sawTotal && sawQtde && sumQtde !== 0) {
      const result = roundMoney(sumTotal / sumQtde);
      log.info(
        'consolidado',
        `${key} recalculado via ${pair.totalKey}/${pair.qtdeKey} = ${result}`,
      );
      return result;
    }
  }

  // 2) Fallback ponderado: sum(ticket_i * qtde_i) / sum(qtde_i)
  const qtdeKey = pair?.qtdeKey;
  if (qtdeKey) {
    let weighted = 0;
    let sumQtde = 0;
    let used = false;

    for (const values of lojaEntries) {
      const ticket = asNumber(values[key]);
      const qtde = asNumber(values[qtdeKey]);
      if (ticket === null || qtde === null || qtde === 0) continue;
      weighted += ticket * qtde;
      sumQtde += qtde;
      used = true;
    }

    if (used && sumQtde !== 0) {
      const result = roundMoney(weighted / sumQtde);
      log.info(
        'consolidado',
        `${key} recalculado via média ponderada (ticket*qtde)/qtde = ${result}`,
      );
      return result;
    }
  }

  // 3) Sem bases suficientes — null + aviso (não inventa)
  const needed = pair
    ? `${pair.totalKey} e ${pair.qtdeKey} (ou ${key}+${pair.qtdeKey} por loja)`
    : 'pares total/qtde correspondentes';
  log.warn(
    'consolidado',
    `ticket médio "${key}" sem campos base para recálculo (${needed}) — retornando null`,
  );
  return null;
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Quando o escopo precisa de consolidado e há ticket_medio_*,
 * garante que as qtdes correspondentes também sejam scrapadas
 * (mesmo que não estejam no pedido original — entram só no cálculo).
 */
export function expandCamposForScrape(campos: CampoRequest[]): CampoRequest[] {
  const byKey = new Map(campos.map((c) => [c.key, c]));

  for (const campo of campos) {
    if (!campo.key.startsWith('ticket_medio')) continue;
    const pair = TICKET_MEDIO_PAIRS[campo.key];
    if (!pair) continue;
    if (!byKey.has(pair.qtdeKey)) {
      byKey.set(pair.qtdeKey, {
        key: pair.qtdeKey,
        label: guessQtdeLabel(pair.qtdeKey),
      });
    }
    if (!byKey.has(pair.totalKey)) {
      byKey.set(pair.totalKey, {
        key: pair.totalKey,
        label: guessTotalLabel(pair.totalKey),
      });
    }
  }

  return Array.from(byKey.values());
}

function guessQtdeLabel(key: string): string {
  const map: Record<string, string> = {
    qtde_entrega: 'Qtde Entrega',
    qtde_balcao: 'Qtde Balcão',
    qtde_ficha: 'Qtde Ficha',
    qtde_salao_clientes: 'Qtde Salão / Clientes atendidos',
    qtde_pedidos: 'Quantidade de pedidos',
  };
  return map[key] ?? key;
}

function guessTotalLabel(key: string): string {
  const map: Record<string, string> = {
    total_entrega: 'Total Entrega',
    total_balcao: 'Total Balcão',
    total_mesa: 'Total Mesa',
    total_ficha: 'Total Ficha',
    total_pedidos: 'Total dos pedidos (R$)',
  };
  return map[key] ?? key;
}

/** Filtra o consolidado/porLoja para devolver só as keys pedidas pelo cliente. */
export function pickRequestedKeys(
  values: FieldValues,
  campos: CampoRequest[],
): FieldValues {
  const out: FieldValues = {};
  for (const c of campos) {
    out[c.key] = values[c.key] ?? null;
  }
  return out;
}
