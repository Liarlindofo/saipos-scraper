/**
 * Snippet para o node "Formatar Mensagem" do n8n.
 *
 * Cole no Code node (modo "Run Once for All Items" ou ajuste conforme
 * o formato atual do workflow). A resposta do scraper agora inclui:
 *
 *   falhasExtracao?: string[]   // ex: ["ahu"]
 *
 * Use isso (ou a checagem all-null/N-D abaixo) para NÃO listar "N/D"
 * campo a campo como se fosse dia sem movimento.
 */

const NOMES = {
  ahu: 'Ahú',
  pilarzinho: 'Pilarzinho',
  portao: 'Portão',
  uberaba: 'Uberaba',
};

function isEmptyValue(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' || /^n[\s\/\-]?d$/i.test(t) || t === '—';
  }
  return false;
}

function lojaAllNullOrND(fields) {
  if (!fields || typeof fields !== 'object') return true;
  const vals = Object.values(fields);
  if (vals.length === 0) return true;
  return vals.every(isEmptyValue);
}

function formatLojaBlock(slug, fields, falhasExtracao) {
  const nome = NOMES[slug] || slug;
  const falhou =
    (Array.isArray(falhasExtracao) && falhasExtracao.includes(slug)) ||
    lojaAllNullOrND(fields);

  if (falhou) {
    return `⚠️ Falha ao capturar dados de ${nome} — verificar manualmente`;
  }

  // --- adapte ao layout atual do node ---
  // Exemplo mínimo:
  const lines = [`*${nome}*`];
  for (const [key, val] of Object.entries(fields || {})) {
    lines.push(`• ${key}: ${val}`);
  }
  return lines.join('\n');
}

// Ajuste: de onde vem o JSON do scraper no seu workflow
const data = $input.first().json; // ou $json / items[0].json
const porLoja = data.porLoja || {};
const falhas = data.falhasExtracao || [];

const blocos = Object.keys(porLoja).map((slug) =>
  formatLojaBlock(slug, porLoja[slug], falhas),
);

// Se só veio consolidado e falhasExtracao aponta lojas, ainda vale avisar:
for (const slug of falhas) {
  if (!(slug in porLoja)) {
    blocos.push(
      `⚠️ Falha ao capturar dados de ${NOMES[slug] || slug} — verificar manualmente`,
    );
  }
}

return [
  {
    json: {
      ...data,
      mensagem: blocos.join('\n\n'),
    },
  },
];
