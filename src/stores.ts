import type { StoreDef, StoreSlug } from './types.js';

/** nomesNaTabela = texto exato/parcial na coluna Nome do modal "Selecione a loja" */
export const STORES: StoreDef[] = [
  { slug: 'ahu', nome: 'Ahú', id: 1969, nomeNaTabela: 'Calenzano - Ahu' },
  { slug: 'pilarzinho', nome: 'Pilarzinho', id: 1896, nomeNaTabela: 'Calenzano - Pilarzinho' },
  { slug: 'portao', nome: 'Portão', id: 1759, nomeNaTabela: 'Calenzano - Portão' },
  { slug: 'uberaba', nome: 'Uberaba', id: 8475, nomeNaTabela: 'Calenzano - Uberaba' },
];

export const STORE_BY_SLUG: Record<StoreSlug, StoreDef> = Object.fromEntries(
  STORES.map((s) => [s.slug, s]),
) as Record<StoreSlug, StoreDef>;

export function resolveStores(lojas?: StoreSlug[]): StoreDef[] {
  if (!lojas || lojas.length === 0) return STORES;
  const resolved = lojas.map((slug) => {
    const store = STORE_BY_SLUG[slug];
    if (!store) {
      throw new Error(
        `Loja desconhecida: "${slug}". Válidas: ${STORES.map((s) => s.slug).join(', ')}`,
      );
    }
    return store;
  });
  return resolved;
}
