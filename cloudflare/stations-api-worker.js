const UPSTREAM_URL = "https://gde-benzin.ru/api/stations";
const APP_ORIGINS = new Set([
  "https://barsuk2882.github.io",
  "http://localhost:8876",
  "http://127.0.0.1:8876",
]);
const MAX_LAT_SPAN = 1.5;
// Зум карты FuelWise может показывать Москву и область в широкой панели.
// Источник проверен на области шириной 4°: ответ 200, без усечения.
const MAX_LON_SPAN = 4.0;

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const headers = new Headers({
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept",
    "Access-Control-Max-Age": "86400",
  });
  if (APP_ORIGINS.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function jsonResponse(request, status, body, extraHeaders = {}) {
  const headers = corsHeaders(request);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  return new Response(JSON.stringify(body), { status, headers });
}

function parseBounds(rawBounds) {
  if (!rawBounds) return null;
  const values = rawBounds.split(",").map((value) => Number(value.trim()));
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return null;
  const [south, west, north, east] = values;
  if (south < -90 || north > 90 || west < -180 || east > 180) return null;
  if (south >= north || west >= east) return null;
  if (north - south > MAX_LAT_SPAN || east - west > MAX_LON_SPAN) return null;
  return values.map((value) => value.toFixed(4)).join(",");
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/stations") {
      return jsonResponse(request, 404, { error: "Маршрут API не найден." });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (request.method !== "GET") {
      return jsonResponse(request, 405, { error: "Поддерживается только GET." }, { Allow: "GET, OPTIONS" });
    }

    const bbox = parseBounds(url.searchParams.get("bbox"));
    if (!bbox) {
      return jsonResponse(request, 400, { error: "Укажите корректную область карты небольшого размера." });
    }

    const upstream = new URL(UPSTREAM_URL);
    upstream.searchParams.set("bbox", bbox);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(upstream, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "FuelWise-Pilot/3.1 (+https://barsuk2882.github.io/fuelwise/)",
        },
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        return jsonResponse(request, 502, { error: "Источник АЗС перенаправил запрос; повторите позже." });
      }
      const payload = await response.text();
      if (!response.ok) {
        const retryAfter = response.headers.get("Retry-After");
        return jsonResponse(request, response.status, { error: "Источник АЗС временно не принял запрос." },
          retryAfter ? { "Retry-After": retryAfter } : {});
      }
      try {
        const data = JSON.parse(payload);
        if (!Array.isArray(data.stations)) {
          return jsonResponse(request, 502, { error: "Источник АЗС вернул данные неизвестного формата." });
        }
        return jsonResponse(request, 200, data);
      } catch {
        return jsonResponse(request, 502, { error: "Источник АЗС вернул некорректный JSON." });
      }
    } catch (error) {
      const message = error.name === "AbortError"
        ? "Источник АЗС не ответил за 15 секунд."
        : "Не удалось связаться с источником АЗС.";
      return jsonResponse(request, 502, { error: message });
    } finally {
      clearTimeout(timeout);
    }
  },
};
