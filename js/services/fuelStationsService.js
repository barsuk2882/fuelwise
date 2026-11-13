// Локальный справочник используется для списка видов топлива в форме.
(() => {
  const ns = (globalThis.FuelWise ??= {});

  // Правки хранятся словарём { id: заправка | null }; null означает удаление.
  async function getAllStations() {
    const { fuelStations } = await ns.demoDataLoader.getDemoData();
    return fuelStations;
  }

  // Заправки, где топливо этого типа есть в ассортименте. Поле fuel содержит
  // цену и признак наличия: недоступное топливо отсеивается уже при рекомендации.
  async function getNearbyStations(routeGeometry, fuelType, maxDetourKm) {
    if (!Array.isArray(routeGeometry) || routeGeometry.length < 2 || !ns.liveFuelStationsService) return [];

    const lats = routeGeometry.map(([lat]) => lat);
    const lons = routeGeometry.map(([, lon]) => lon);
    const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const paddingLat = maxDetourKm / 110.574;
    const paddingLon = maxDetourKm / Math.max(20, 111.32 * Math.cos((midLat * Math.PI) / 180));
    const south = Math.max(-90, Math.min(...lats) - paddingLat);
    const north = Math.min(90, Math.max(...lats) + paddingLat);
    const west = Math.max(-180, Math.min(...lons) - paddingLon);
    const east = Math.min(180, Math.max(...lons) + paddingLon);
    const bounds = {
      getSouth: () => south,
      getWest: () => west,
      getNorth: () => north,
      getEast: () => east,
    };

    const code = /100/.test(fuelType) ? "ai100"
      : /98/.test(fuelType) ? "ai98"
        : /95/.test(fuelType) ? "ai95"
          : /92/.test(fuelType) ? "ai92"
            : /диз|diesel/i.test(fuelType) ? "dt" : "";
    if (!code) return [];

    try {
      const result = await ns.liveFuelStationsService.getStationsInBounds(bounds);
      return result.stations
        .map((station) => {
          const fuel = station.fuels?.[code];
          if (!fuel) return null;
          return {
            ...station,
            fuel: {
              type: fuel.label,
              available: fuel.available,
              pricePerLiter: fuel.price,
            },
            ...ns.calculations.projectPointOnRoute([station.lat, station.lon], routeGeometry),
          };
        })
        .filter((station) => station && station.offRouteKm <= maxDetourKm);
    } catch (error) {
      console.warn("Не удалось загрузить АЗС рядом с маршрутом:", error);
      return [];
    }
  }

  ns.fuelStationsService = { getAllStations, getNearbyStations };
})();
