// Читает публичные сведения о заправках в пределах заданной области карты.
(() => {
  const ns = (globalThis.FuelWise ??= {});
  const DIRECT_API_URL = "https://gde-benzin.ru/api/stations";
  const OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  ];
  const FUEL_TYPES = {
    ai92: "АИ-92",
    ai95: "АИ-95",
    ai98: "АИ-98",
    ai100: "АИ-100",
    dt: "Дизель",
  };
  const cache = new Map();
  const CACHE_TTL_MS = 60 * 1000;
  let snapshotPromise = null;

  async function fetchWithTimeout(url, options, parentSignal, timeoutMs) {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  }

  function toNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function apiUrl() {
    const configuredProxy = String(globalThis.FUELWISE_STATIONS_API_URL || "").trim();
    if (!configuredProxy) return new URL(DIRECT_API_URL);
    const baseUrl = new URL(configuredProxy, location.href);
    const basePath = baseUrl.pathname.endsWith("/") ? baseUrl.pathname.slice(0, -1) : baseUrl.pathname;
    baseUrl.pathname = `${basePath}/api/stations`;
    baseUrl.search = "";
    baseUrl.hash = "";
    return baseUrl;
  }

  function apiFailureMessage(error) {
    const proxyUrl = String(globalThis.FUELWISE_STATIONS_API_URL || "").trim();
    if (!proxyUrl) {
      return "Не настроен CORS-прокси. GitHub Pages не может читать API напрямую; разверните cloudflare/stations-api-worker.js и укажите его URL в js/services/stationsApiConfig.js.";
    }
    return error?.message || "ошибка сети";
  }

  function normalizeStation(station) {
    const lat = toNumber(station?.lat ?? station?.latitude);
    const lon = toNumber(station?.lon ?? station?.lng ?? station?.longitude);
    if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return null;
    }

    const fuels = {};
    for (const [code, label] of Object.entries(FUEL_TYPES)) {
      const availability = station.fuels?.[code];
      const priceRecord = station.prices?.[code];
      const fuelDetails = typeof availability === "object" && availability !== null ? availability : {};
      const rawPrice = typeof priceRecord === "object" && priceRecord !== null
        ? priceRecord.price
        : fuelDetails.price ?? priceRecord;
      const price = toNumber(rawPrice);
      const freshnessSeconds = toNumber(
        (typeof priceRecord === "object" && priceRecord !== null
          ? priceRecord.freshness_seconds
          : null) ?? fuelDetails.price_freshness_seconds ?? fuelDetails.freshness_seconds,
      );

      fuels[code] = {
        label,
        available: typeof availability === "boolean" ? availability : fuelDetails.available ?? null,
        price,
        priceReports: toNumber(priceRecord?.n),
        freshnessSeconds,
        availabilityFreshnessSeconds: toNumber(fuelDetails.freshness_seconds),
      };
    }

    return {
      id: String(station.id ?? `${lat.toFixed(6)}_${lon.toFixed(6)}`),
      name: String(station.name || station.brand || "Заправочная станция"),
      brand: String(station.brand || station.operator || "Сеть не указана"),
      address: String(station.address || "Адрес не указан"),
      lat,
      lon,
      mapUrl: typeof station.map_url === "string" ? station.map_url : "",
      fuels,
    };
  }

  function boundsToQuery(bounds) {
    const south = Number(bounds.getSouth().toFixed(4));
    const west = Number(bounds.getWest().toFixed(4));
    const north = Number(bounds.getNorth().toFixed(4));
    const east = Number(bounds.getEast().toFixed(4));
    return {
      key: [south, west, north, east].join(","),
      value: `${south},${west},${north},${east}`,
    };
  }

  function normalizeOsmStation(element) {
    const tags = element.tags || {};
    const lat = toNumber(element.lat ?? element.center?.lat);
    const lon = toNumber(element.lon ?? element.center?.lon);
    if (lat === null || lon === null) return null;

    const osmFuelTags = {
      ai92: "fuel:octane_92",
      ai95: "fuel:octane_95",
      ai98: "fuel:octane_98",
      ai100: "fuel:octane_100",
      dt: "fuel:diesel",
    };
    const fuels = {};
    for (const [code, tag] of Object.entries(osmFuelTags)) {
      const value = String(tags[tag] || "").toLowerCase();
      fuels[code] = {
        label: FUEL_TYPES[code],
        available: value === "yes" ? true : value === "no" ? false : null,
        price: null,
        priceReports: null,
        freshnessSeconds: null,
        availabilityFreshnessSeconds: null,
      };
    }

    const address = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(", ")
      || tags["addr:full"] || "Адрес не указан";
    return {
      id: `osm-${element.type}-${element.id}`,
      name: tags.name || tags.brand || "Заправочная станция",
      brand: tags.brand || tags.operator || "Сеть не указана",
      address,
      lat,
      lon,
      mapUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
      fuels,
      dataSource: "OpenStreetMap",
    };
  }

  async function getOsmStations(query, signal) {
    const [south, west, north, east] = query.value.split(",");
    const area = `${south},${west},${north},${east}`;
    const overpassQuery = `[out:json][timeout:5];(node["amenity"="fuel"](${area});way["amenity"="fuel"](${area});relation["amenity"="fuel"](${area}););out center tags;`;
    let lastError = null;
    for (let index = 0; index < OVERPASS_URLS.length; index += 2) {
      const pairController = new AbortController();
      const abortFromParent = () => pairController.abort();
      if (signal?.aborted) pairController.abort();
      else signal?.addEventListener("abort", abortFromParent, { once: true });

      const requests = OVERPASS_URLS.slice(index, index + 2).map(async (endpoint) => {
        const url = new URL(endpoint);
        url.searchParams.set("data", overpassQuery);
        const response = await fetchWithTimeout(url, { method: "GET", referrerPolicy: "origin" }, pairController.signal, 6000);
        if (!response.ok) throw new Error(`OpenStreetMap ответил с ошибкой (${response.status}).`);
        const payload = await response.json();
        if (!Array.isArray(payload.elements)) throw new Error("OpenStreetMap вернул данные в неизвестном формате.");
        const stations = payload.elements.map(normalizeOsmStation).filter(Boolean);
        return { stations, count: stations.length, truncated: false, checkedAt: new Date().toISOString(), source: "OpenStreetMap" };
      });

      try {
        return await Promise.any(requests);
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error.errors?.find((item) => item.name !== "AbortError" && item.message)
          || new Error("Публичные сервисы OpenStreetMap временно не отвечают.");
      } finally {
        pairController.abort();
        signal?.removeEventListener("abort", abortFromParent);
      }
    }
    if (lastError?.name === "AbortError") {
      throw new Error("Сервисы OpenStreetMap не ответили вовремя. Попробуйте обновить карту позже.");
    }
    throw lastError || new Error("Не удалось загрузить точки АЗС из OpenStreetMap.");
  }

  async function getSnapshotStations(query) {
    const embeddedSnapshot = globalThis.FUELWISE_MOSCOW_STATIONS;
    if (Array.isArray(embeddedSnapshot?.stations)) {
      snapshotPromise ??= Promise.resolve(embeddedSnapshot);
    } else {
      snapshotPromise ??= fetch("data/moscow-stations.snapshot.json")
        .then((response) => {
          if (!response.ok) throw new Error("Не удалось прочитать резервный список АЗС.");
          return response.json();
        })
        .then((payload) => {
          if (!Array.isArray(payload.stations)) throw new Error("Резервный список АЗС имеет неверный формат.");
          return payload;
        })
        .catch((error) => {
          snapshotPromise = null;
          const fallback = globalThis.FUELWISE_MOSCOW_STATIONS;
          if (Array.isArray(fallback?.stations)) {
            console.warn("JSON-список АЗС недоступен; используется встроенная копия.", error);
            return fallback;
          }
          console.error("Не удалось прочитать локальный список АЗС.", error);
          throw new Error("Не удалось прочитать резервный список АЗС. Проверьте подключение и обновите страницу.");
        });
    }

    const snapshot = await snapshotPromise;
    const [south, west, north, east] = query.value.split(",").map(Number);
    const stations = snapshot.stations
      .filter((station) => station.lat >= south && station.lat <= north && station.lon >= west && station.lon <= east)
      .map(normalizeStation)
      .filter(Boolean)
      .map((station) => ({ ...station, dataSource: "Gde-Benzin (резервный список координат)" }));

    if (!stations.length) throw new Error("В резервном списке нет станций в видимой области карты.");
    return {
      stations,
      count: stations.length,
      truncated: false,
      checkedAt: snapshot.fetchedAt,
      source: "Snapshot",
      stale: true,
      fallbackReason: "Онлайн-источники не ответили. Показаны реальные координаты из резервного списка; цены и наличие не обновлялись.",
    };
  }

  async function getStationsInBounds(bounds, signal, forceRefresh = false) {
    const query = boundsToQuery(bounds);
    const cached = cache.get(query.key);
    if (!forceRefresh && cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
      return cached.value;
    }

    const url = apiUrl();
    url.searchParams.set("bbox", query.value);
    let result;
    try {
      const response = await fetchWithTimeout(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      }, signal, 18000);
      if (!response.ok) {
        let sourceMessage = "";
        try {
          const errorPayload = await response.json();
          if (typeof errorPayload?.error === "string") sourceMessage = errorPayload.error;
        } catch {
          // Если источник прислал не JSON, используем понятное сообщение по HTTP-статусу.
        }
        if (response.status === 429) {
          const rateLimitError = new Error(sourceMessage || "Источник временно ограничил частоту запросов (429). Повторите позже.");
          rateLimitError.status = 429;
          throw rateLimitError;
        }
        throw new Error(sourceMessage || `Источник цен ответил с ошибкой (${response.status}).`);
      }

      const payload = await response.json();
      if (!Array.isArray(payload.stations)) throw new Error("Источник цен вернул данные в неизвестном формате.");
      result = {
        stations: payload.stations.map(normalizeStation).filter(Boolean),
        count: Number.isFinite(Number(payload.count)) ? Number(payload.count) : payload.stations.length,
        truncated: Boolean(payload.truncated),
        checkedAt: new Date().toISOString(),
        source: "Gde-Benzin",
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      try {
        result = await getOsmStations(query, signal);
        result.fallbackReason = `${apiFailureMessage(error)} Цены не обновлены; показаны координаты из OpenStreetMap.`;
      } catch (osmError) {
        if (signal?.aborted) throw osmError;
        if (cached?.value?.stations?.length) {
          return {
            ...cached.value,
            stale: true,
            fallbackReason: "Сеть не ответила. Показан ранее загруженный список; проверьте его актуальность.",
          };
        }
        try {
          result = await getSnapshotStations(query);
          result.diagnostic = `${apiFailureMessage(error)} OpenStreetMap: ${osmError.message || "не ответил"}.`;
        } catch (snapshotError) {
          throw new Error(`${osmError.message} Резервный список не удалось прочитать: ${snapshotError.message}`);
        }
      }
    }
    cache.set(query.key, { savedAt: Date.now(), value: result });
    return result;
  }

  ns.liveFuelStationsService = { getStationsInBounds, fuelTypes: FUEL_TYPES };
})();
