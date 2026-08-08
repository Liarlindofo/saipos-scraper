import { withPage, closeBrowser, clearChromiumLocks } from './browser.js';
import { assertCredentials } from './config.js';
import {
  buildConsolidado,
  expandCamposForScrape,
  pickRequestedKeys,
} from './consolidate.js';
import { clickBuscar } from './modules/clickBuscar.js';
import { extractFields } from './modules/extractFields.js';
import { goToSalesByPeriodReport } from './modules/goToSalesByPeriodReport.js';
import { login } from './modules/login.js';
import { setDateRange } from './modules/setDateRange.js';
import { switchStore } from './modules/switchStore.js';
import { resolveStores } from './stores.js';
import type { ScrapeRequest, ScrapeResult, FieldValues } from './types.js';
import { log } from './utils/logger.js';

/** Mutex simples — um scrape por vez (mesmo browser/perfil). */
let scrapeLock: Promise<void> = Promise.resolve();

export async function scrapeReport(req: ScrapeRequest): Promise<ScrapeResult> {
  assertCredentials();

  if (!req.data || !/^\d{2}\/\d{2}\/\d{4}$/.test(req.data)) {
    throw new Error(`data inválida (use dd/MM/yyyy): ${req.data}`);
  }
  if (!['POR_LOJA', 'CONSOLIDADO', 'AMBOS'].includes(req.escopoLoja)) {
    throw new Error(`escopoLoja inválido: ${req.escopoLoja}`);
  }
  if (!Array.isArray(req.campos) || req.campos.length === 0) {
    throw new Error('campos deve ser um array não vazio de { key, label }');
  }

  const stores = resolveStores(req.lojas);
  const needsConsolidado =
    req.escopoLoja === 'CONSOLIDADO' || req.escopoLoja === 'AMBOS';
  const scrapeCampos = needsConsolidado
    ? expandCamposForScrape(req.campos)
    : req.campos;

  // Enfileira scrapes
  let release!: () => void;
  const previous = scrapeLock;
  scrapeLock = new Promise<void>((r) => {
    release = r;
  });
  await previous;

  log.info('scrapeReport', 'Início', {
    data: req.data,
    escopoLoja: req.escopoLoja,
    lojas: stores.map((s) => s.slug),
    campos: req.campos.map((c) => c.key),
  });

  try {
    return await withPage(async (page) => {
      await login(page);

      const porLojaRaw: Record<string, FieldValues> = {};

      for (const store of stores) {
        const step = `loja:${store.slug}`;
        try {
          log.info(step, `=== ${store.nome} (ID ${store.id}) ===`);

          await switchStore(page, {
            lojaId: store.id,
            nomeNaTabela: store.nomeNaTabela,
            cnpj: store.cnpj,
          });
          await goToSalesByPeriodReport(page);
          await setDateRange(page, req.data, req.data);
          await clickBuscar(page);

          const values = await extractFields(page, scrapeCampos);
          porLojaRaw[store.slug] = values;

          log.info(step, 'OK', pickRequestedKeys(values, req.campos));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(step, `Falha: ${msg}`);

          // Se caiu na tela de login no meio do fluxo, tenta 1 retry de sessão
          if (/login|sessão|session|access\/login/i.test(msg)) {
            log.warn(step, 'Possível sessão expirada — retry de login uma vez');
            await login(page);
            await switchStore(page, {
              lojaId: store.id,
              nomeNaTabela: store.nomeNaTabela,
              cnpj: store.cnpj,
            });
            await goToSalesByPeriodReport(page);
            await setDateRange(page, req.data, req.data);
            await clickBuscar(page);
            const values = await extractFields(page, scrapeCampos);
            porLojaRaw[store.slug] = values;
            log.info(step, 'OK após retry', pickRequestedKeys(values, req.campos));
          } else {
            throw new Error(`[${store.slug}] ${msg}`);
          }
        }
      }

      const porLoja: Record<string, FieldValues> = {};
      for (const [slug, values] of Object.entries(porLojaRaw)) {
        porLoja[slug] = pickRequestedKeys(values, req.campos);
      }

      let consolidado: FieldValues | null = null;
      if (needsConsolidado) {
        const full = buildConsolidado(porLojaRaw, scrapeCampos);
        consolidado = pickRequestedKeys(full, req.campos);
        log.info('scrapeReport', 'Consolidado', consolidado);
      }

      if (req.escopoLoja === 'CONSOLIDADO') {
        return { porLoja: {}, consolidado };
      }

      return { porLoja, consolidado };
    });
  } catch (err) {
    // Em erro grave, fecha o browser para não acumular páginas/processos órfãos
    log.error('scrapeReport', 'Erro — fechando browser para limpar estado');
    await closeBrowser();
    clearChromiumLocks();
    throw err;
  } finally {
    release();
  }
}
