/**
 * Converte textos do painel Saipos ("R$ 1.234,56", "1.234", "12,5%") em number.
 * Retorna null se vazio/não parseável.
 */
export function parseSaiposValue(raw: string | null | undefined): number | string | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.replace(/\u00a0/g, ' ').trim();
  if (!text || text === '-' || text === '—') return null;

  // Percentuais: mantém string original (não faz parte do consolidado típico)
  if (text.includes('%')) return text;

  let cleaned = text
    .replace(/R\$\s?/gi, '')
    .replace(/\s/g, '')
    .trim();

  // Formato BR: 1.234.567,89
  if (/^-?\d{1,3}(\.\d{3})*(,\d+)?$/.test(cleaned) || /^-?\d+,\d+$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (/^-?\d+\.\d+$/.test(cleaned)) {
    // já decimal com ponto
  } else {
    cleaned = cleaned.replace(/[^\d.-]/g, '');
  }

  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : text;
}

export function isSummableKey(key: string): boolean {
  if (key.startsWith('ticket_medio')) return false;
  return (
    key.startsWith('qtde_') ||
    key.startsWith('total_') ||
    key.startsWith('valor_total_') ||
    key.startsWith('valor_') ||
    key.startsWith('canal_') ||
    key === 'pedidos_cancelados' ||
    key === 'cupons_a_emitir'
  );
}

/**
 * Pares para recálculo de ticket médio no consolidado.
 * total monetário ÷ quantidade — ambos precisam existir nos valores somados.
 *
 * Observação: o catálogo Plateful tem qtde_* por modalidade, mas NÃO tem
 * total monetário por modalidade (total_entrega, etc.). Quando o total
 * correspondente não estiver disponível no payload scrapado, o consolidado
 * devolve null + aviso (não inventa número).
 *
 * Fallback ponderado: se houver ticket_medio_* e qtde_* por loja,
 * usa sum(ticket_i * qtde_i) / sum(qtde_i).
 */
export const TICKET_MEDIO_PAIRS: Record<
  string,
  { totalKey: string; qtdeKey: string }
> = {
  ticket_medio_entrega: { totalKey: 'total_entrega', qtdeKey: 'qtde_entrega' },
  ticket_medio_balcao: { totalKey: 'total_balcao', qtdeKey: 'qtde_balcao' },
  ticket_medio_mesa: { totalKey: 'total_mesa', qtdeKey: 'qtde_salao_clientes' },
  ticket_medio_ficha: { totalKey: 'total_ficha', qtdeKey: 'qtde_ficha' },
};
