// Автомобильные маршруты запрашиваются у OSRM и приводятся к формату приложения.
(() => {
  const ns = (globalThis.FuelWise ??= {});
  const ROUTE_URL = "https://router.project-osrm.org/route/v1/driving";
  const MIN_INTERVAL_MS = 1100;
  let lastRequestAt = 0;
  let requestQueue = Promise.resolve();

  async function waitForSlot() {
    const waitMs = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastRequestAt = Date.now();
  }

  function queuedFetch(url) {
    const request = requestQueue.then(async () => {
      await waitForSlot();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        return await fetch(url, {
          headers: { Accept: "application/json" },
          referrerPolicy: "origin",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    });
    requestQueue = request.catch(() => {});
    return request;
  }

  function normalizeRoute(route, index, start, end) {
    const coordinates = route?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;

    const geometry = coordinates.map((coordinate) => [Number(coordinate[1]), Number(coordinate[0])])
      .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
    const distanceKm = Number(route.distance) / 1000;
    const durationMinutes = Number(route.duration) / 60;
    if (geometry.length < 2 || !Number.isFinite(distanceKm) || distanceKm <= 0 || !Number.isFinite(durationMinutes)) {
      return null;
    }

    return {
      id: `osrm-${index}`,
      name: `${start.name} — ${end.name}${index ? ` · вариант ${index + 1}` : ""}`,
      start,
      end,
      distanceKm,
      durationMinutes,
      geometry,
      alternatives: [],
      source: "OSRM",
    };
  }

  async function getRoute(start, end) {
    if (!start || !end || !Number.isFinite(Number(start.lat)) || !Number.isFinite(Number(start.lon)) ||
        !Number.isFinite(Number(end.lat)) || !Number.isFinite(Number(end.lon))) {
      throw new Error("Выберите найденные точки А и Б перед построением маршрута.");
    }
    if (Math.abs(start.lat - end.lat) < 0.000001 && Math.abs(start.lon - end.lon) < 0.000001) {
      throw new Error("Точка А и точка Б не могут совпадать.");
    }

    const coordinates = `${Number(start.lon)},${Number(start.lat)};${Number(end.lon)},${Number(end.lat)}`;
    const url = new URL(`${ROUTE_URL}/${coordinates}`);
    url.searchParams.set("alternatives", "2");
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("overview", "full");
    url.searchParams.set("steps", "false");

    let response;
    try {
      response = await queuedFetch(url);
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Построение маршрута заняло слишком много времени. Попробуйте ещё раз.");
      }
      throw new Error("Сервис маршрутов недоступен. Проверьте интернет и повторите попытку.");
    }

    if (!response.ok) {
      throw new Error(`Сервис маршрутов ответил с ошибкой (${response.status}). Попробуйте позже.`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Сервис маршрутов вернул ответ в неизвестном формате.");
    }

    if (payload.code === "NoRoute" || !Array.isArray(payload.routes) || !payload.routes.length) {
      throw new Error("Для выбранных точек не найден автомобильный маршрут. Проверьте адреса или задайте точки на карте.");
    }
    if (payload.code !== "Ok") {
      throw new Error("Сервис не смог построить маршрут между выбранными точками.");
    }

    const routes = payload.routes.map((route, index) => normalizeRoute(route, index, start, end)).filter(Boolean);
    if (!routes.length) {
      throw new Error("Сервис маршрутов не вернул линию маршрута. Выберите точки на дороге и повторите попытку.");
    }

    routes[0].alternatives = routes.slice(1);
    return routes[0];
  }

  async function getAlternativeRoutes(route) {
    return route.alternatives || [];
  }

  ns.routingService = { getRoute, getAlternativeRoutes };
})();
