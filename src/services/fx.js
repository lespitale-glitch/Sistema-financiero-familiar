/**
 * Cotizacion de monedas para registrar gastos en dolares.
 *
 * Prioridad:
 *  1. USD_ARS_RATE fija en el .env (no usa red).
 *  2. dolarapi.com (USD_RATE_SOURCE: oficial, blue, bolsa, tarjeta, ...),
 *     con cache de 1 hora y respaldo de hasta 24 horas si la API falla.
 *
 * Solo convierte USD -> moneda base ARS. Cualquier otra combinacion devuelve
 * ok:false para que el usuario cargue el monto en la moneda configurada.
 */

const CACHE_TTL_MS = 60 * 60 * 1000;
const STALE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const SOURCE_LABELS = Object.freeze({
  oficial: 'dólar oficial',
  blue: 'dólar blue',
  bolsa: 'dólar MEP',
  mep: 'dólar MEP',
  contadoconliqui: 'dólar CCL',
  tarjeta: 'dólar tarjeta',
  mayorista: 'dólar mayorista',
  cripto: 'dólar cripto',
  manual: 'cotización fija',
});

/** Etiqueta legible de la fuente de cotizacion. */
export function fxSourceLabel(source) {
  return SOURCE_LABELS[source] || `dólar ${source}`;
}

export function createFxService({ config, logger, fetchImpl = globalThis.fetch, clock = () => new Date() } = {}) {
  const baseCurrency = String(config?.app?.currency || 'ARS').toUpperCase();
  const fixedRate = Number(config?.fx?.usdRate) > 0 ? Number(config.fx.usdRate) : null;
  const rawSource = String(config?.fx?.usdSource || 'oficial').toLowerCase();
  const source = rawSource === 'mep' ? 'bolsa' : rawSource;
  const apiUrl = String(config?.fx?.apiUrl || 'https://dolarapi.com/v1/dolares').replace(/\/+$/, '');

  let cache = null; // { rate, fetchedAt }

  async function fetchRate() {
    if (typeof fetchImpl !== 'function') throw new Error('fetch no disponible');
    const response = await fetchImpl(`${apiUrl}/${encodeURIComponent(source)}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response?.ok) throw new Error(`la API de cotizacion respondio ${response?.status ?? 'error'}`);
    const body = await response.json();
    const rate = Number(body?.venta);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('la API de cotizacion no devolvio "venta"');
    return rate;
  }

  /**
   * Cotizacion from -> to.
   * @returns {Promise<{ok: true, rate: number, source: string, stale?: boolean} | {ok: false, error: string}>}
   */
  async function getRate(from, to = baseCurrency) {
    const origin = String(from || '').toUpperCase();
    const target = String(to || baseCurrency).toUpperCase();
    if (origin === target) return { ok: true, rate: 1, source: 'identity' };
    if (origin !== 'USD' || target !== 'ARS') return { ok: false, error: 'moneda-no-soportada' };
    if (fixedRate) return { ok: true, rate: fixedRate, source: 'manual' };

    const now = clock().getTime();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
      return { ok: true, rate: cache.rate, source };
    }
    try {
      const rate = await fetchRate();
      cache = { rate, fetchedAt: now };
      logger?.debug?.('fx: cotizacion actualizada', { source, rate });
      return { ok: true, rate, source };
    } catch (error) {
      logger?.warn?.('fx: no pude obtener la cotizacion', { source, error: error?.message || String(error) });
      if (cache && now - cache.fetchedAt < STALE_TTL_MS) {
        return { ok: true, rate: cache.rate, source, stale: true };
      }
      return { ok: false, error: 'cotizacion-no-disponible' };
    }
  }

  /**
   * Convierte centavos de una moneda a la moneda base.
   * @returns {Promise<{ok: true, amountCents: number, rate: number, source: string, originalAmountCents: number, originalCurrency: string} | {ok: false, error: string}>}
   */
  async function convert(amountCents, from, to = baseCurrency) {
    const result = await getRate(from, to);
    if (!result.ok) return result;
    const converted = Math.round(Number(amountCents) * result.rate);
    if (!Number.isSafeInteger(converted) || converted <= 0) return { ok: false, error: 'monto-invalido' };
    return {
      ok: true,
      amountCents: converted,
      rate: result.rate,
      source: result.source,
      stale: Boolean(result.stale),
      originalAmountCents: Number(amountCents),
      originalCurrency: String(from).toUpperCase(),
    };
  }

  return { baseCurrency, getRate, convert };
}
