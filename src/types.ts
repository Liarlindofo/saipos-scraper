export type EscopoLoja = 'POR_LOJA' | 'CONSOLIDADO' | 'AMBOS';

export type StoreSlug = 'ahu' | 'pilarzinho' | 'portao' | 'uberaba';

export interface CampoRequest {
  key: string;
  label: string;
}

export interface ScrapeRequest {
  data: string; // dd/MM/yyyy
  escopoLoja: EscopoLoja;
  campos: CampoRequest[];
  /** Opcional: filtra lojas (ex: ["ahu"]). Default = todas. */
  lojas?: StoreSlug[];
}

export type FieldValues = Record<string, number | string | null>;

export interface ScrapeResult {
  porLoja: Record<string, FieldValues>;
  consolidado: FieldValues | null;
  /**
   * Slugs em que a extração veio toda null após retry (falha de captura,
   * não "dia sem movimento"). O n8n deve tratar essas lojas como alerta.
   */
  falhasExtracao?: string[];
}

export interface StoreDef {
  slug: StoreSlug;
  nome: string;
  id: number;
  /** Texto na coluna Nome do modal (ex: "Calenzano - Ahu") */
  nomeNaTabela: string;
  /** CNPJ como aparece na tabela do modal — usado pra confirmar troca */
  cnpj: string;
}
