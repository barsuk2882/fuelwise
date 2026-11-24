// Автомобильные маршруты запрашиваются у OSRM и приводятся к формату приложения.
(() => {
  const ns = (globalThis.FuelWise ??= {});
  const ROUTE_URL = "https://router.project-osrm.org/route/v1/driving";
  const queuedFetch = ns.createRequestQueue(15000);

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
      source: "OSRM",
    };
  }

  async function getRoutes(start, end) {
    if (!start || !end || !Number.isFinite(Number(start.lat)) || !Number.isFinite(Number(start.lon)) ||
        !Number.isFinite(Number(end.lat)) || !Number.isFinite(Number(end.lon))) {
      throw new Error("Выберите найденные точки А и Б перед построением маршрута.");
    }
    if (ns.validation.sameCoordinates(start, end)) {
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

    const { payload } = response;
    if (!payload || typeof payload !== "object") throw new Error("Сервис маршрутов вернул ответ в неизвестном формате.");
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

    return routes;
  }

  ns.routingService = { getRoutes };
})();
