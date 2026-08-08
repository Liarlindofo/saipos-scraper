import type { StoreDef, StoreSlug } from './types.js';

/** nomesNaTabela / cnpj = dados reais do modal "Selecione a loja" */
export const STORES: StoreDef[] = [
  {
    slug: 'ahu',
    nome: 'Ahú',
    id: 1969,
    nomeNaTabela: 'Calenzano - Ahu',
    cnpj: '08.821.071/0001-67',
  },
  {
    slug: 'pilarzinho',
    nome: 'Pilarzinho',
    id: 1896,
    nomeNaTabela: 'Calenzano - Pilarzinho',
    cnpj: '18.845.971/0001-06',
  },
  {
    slug: 'portao',
    nome: 'Portão',
    id: 1759,
    nomeNaTabela: 'Calenzano - Portão',
    cnpj: '06.130.111/0001-07',
  },
  {
    slug: 'uberaba',
    nome: 'Uberaba',
    id: 8475,
    nomeNaTabela: 'Calenzano - Uberaba',
    cnpj: '43.820.853/0001-82',
  },
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
