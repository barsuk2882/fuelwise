(() => {
  const ns = (globalThis.FuelWise ??= {});

  async function getNearbyStations(route, fuelType, maxDetourKm) {
    const type = ns.fuels.find(fuelType);
    if (!type?.osm) return { stations: [], status: "unsupported" };
    const prepared = ns.calculations.prepareGeometry(route.geometry);
    const { south, north, west, east } = prepared.bounds;
    const midLat = (south + north) / 2;
    const paddingLat = maxDetourKm / 110.574;
    const paddingLon = maxDetourKm / Math.max(20, 111.32 * Math.cos(midLat * Math.PI / 180));
    const area = {
      south: Math.max(-90, south - paddingLat), north: Math.min(90, north + paddingLat),
      west: Math.max(-180, west - paddingLon), east: Math.min(180, east + paddingLon),
    };
    // Ограничения области запроса Cloudflare Worker.
    if (area.north - area.south > 1.5 || area.east - area.west > 4) {
      return { stations: [], status: "outside-coverage" };
    }
    try {
      const result = await ns.liveFuelStationsService.getStationsInBounds(area);
      const stations = [];
      for (const station of result.stations) {
        const fuel = station.fuels[type.code];
        if (!fuel) continue;
        const projection = ns.calculations.projectPointOnRoute([station.lat, station.lon], prepared);
        if (projection.offRouteKm > maxDetourKm) continue;
        stations.push({
          ...station, ...projection,
          fuel: {
            type: type.label, available: fuel.available,
            confirmed: result.source === "Gde-Benzin" && !result.stale && fuel.available === true,
            pricePerLiter: fuel.price, priceFreshnessSeconds: fuel.freshnessSeconds,
            priceFromCache: Boolean(result.cacheHit),
          },
        });
      }
      return { stations, source: result.source, checkedAt: result.checkedAt, priceIssue: result.priceIssue,
        stale: Boolean(result.stale), truncated: result.truncated, status: "loaded" };
    } catch (error) {
      console.warn("Не удалось получить АЗС по маршруту:", error);
      return { stations: [], status: "unavailable", priceIssue: error.message };
    }
  }

  ns.fuelStationsService = { getNearbyStations };
})();
