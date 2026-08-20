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
import type { CampoRequest, ScrapeRequest, ScrapeResult, FieldValues } from './types.js';
import { dumpDebugScreenshot } from './utils/debugScreenshot.js';
import { log } from './utils/logger.js';

/** Mutex simples — um scrape por vez (mesmo browser/perfil). */
let scrapeLock: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True se TODOS os campos pedidos vieram null (captura inválida, não dia zerado). */
function allFieldsNull(values: FieldValues, campos: CampoRequest[]): boolean {
  if (campos.length === 0) return false;
  return campos.every((c) => values[c.key] === null || values[c.key] === undefined);
}

/**
 * Extrai campos; se tudo vier null, faz 1 retry de leitura do DOM
 * (sem novo Buscar). Se ainda null, screenshot de debug.
 */
async function extractWithNullRetry(
  page: import('puppeteer-core').Page,
  campos: CampoRequest[],
  storeSlug: string,
): Promise<{ values: FieldValues; falhou: boolean }> {
  let values = await extractFields(page, campos);

  if (!allFieldsNull(values, campos)) {
    return { values, falhou: false };
  }

  log.warn(
    `loja:${storeSlug}`,
    'Extração veio TODA null — aguardando e relendo o DOM (retry)',
  );
  await sleep(1500);
  values = await extractFields(page, campos);

  if (!allFieldsNull(values, campos)) {
    log.info(`loja:${storeSlug}`, 'Retry de extração recuperou dados');
    return { values, falhou: false };
  }

  log.error(
    `loja:${storeSlug}`,
    'Extração ainda toda null após retry — screenshot de debug',
  );
  await dumpDebugScreenshot(page, `extraction-all-null-${storeSlug}`, {
    storeSlug,
    url: page.url(),
  });

  return { values, falhou: true };
}

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
      const falhasExtracao: string[] = [];

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

          const { values, falhou } = await extractWithNullRetry(
            page,
            scrapeCampos,
            store.slug,
          );
          porLojaRaw[store.slug] = values;
          if (falhou) falhasExtracao.push(store.slug);

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
            const { values, falhou } = await extractWithNullRetry(
              page,
              scrapeCampos,
              store.slug,
            );
            porLojaRaw[store.slug] = values;
            if (falhou) falhasExtracao.push(store.slug);
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

      if (falhasExtracao.length > 0) {
        log.warn('scrapeReport', 'Lojas com falha de extração (tudo null)', {
          falhasExtracao,
        });
      }

      if (req.escopoLoja === 'CONSOLIDADO') {
        return { porLoja: {}, consolidado, falhasExtracao };
      }

      return { porLoja, consolidado, falhasExtracao };
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
