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
  const supportedFuels = ns.fuels.types.filter((type) => type.osm);
  const cache = new Map();
  const CACHE_TTL_MS = 60 * 1000;
  const PERSISTED_CACHE_KEY = "fuelwise.v5.liveStationsCache.v1";
  const MAX_PERSISTED_AREAS = 3;
  let snapshotPromise = null;

  function readPersistedStations(key) {
    try {
      const storage = globalThis.localStorage;
      if (!storage) return null;
      const entries = JSON.parse(storage.getItem(PERSISTED_CACHE_KEY) ?? storage.getItem("fuelwise.v3.liveStationsCache.v1") ?? "[]");
      if (!Array.isArray(entries)) return null;
      const requestedBounds = key.split(",").map(Number);
      if (requestedBounds.length !== 4 || requestedBounds.some((value) => !Number.isFinite(value))) return null;
      const [south, west, north, east] = requestedBounds;
      const entry = entries
        .filter((item) => {
          if (!Number.isFinite(item?.savedAt) || item.value?.source !== "Gde-Benzin" ||
            !Array.isArray(item.value.stations) || !item.value.stations.length) return false;
          const cachedBounds = String(item.key || "").split(",").map(Number);
          if (cachedBounds.length !== 4 || cachedBounds.some((value) => !Number.isFinite(value))) return false;
          const [cachedSouth, cachedWest, cachedNorth, cachedEast] = cachedBounds;
          // Use a saved area only when it fully covers the current viewport.
          return cachedSouth <= south && cachedWest <= west && cachedNorth >= north && cachedEast >= east;
        })
        .sort((first, second) => second.savedAt - first.savedAt)[0];
      if (!entry) return null;

      const stations = entry.value.stations.filter((station) =>
        Number.isFinite(station.lat) && Number.isFinite(station.lon) &&
        station.lat >= south && station.lat <= north && station.lon >= west && station.lon <= east,
      );
      return stations.length
        ? { savedAt: entry.savedAt, value: { ...entry.value, stations, count: stations.length } }
        : null;
    } catch {
      return null;
    }
  }

  function persistStations(key, entry) {
    try {
      const storage = globalThis.localStorage;
      if (!storage) return;
      const previous = JSON.parse(storage.getItem(PERSISTED_CACHE_KEY) || "[]");
      const entries = Array.isArray(previous) ? previous : [];
      const next = [
        { key, savedAt: entry.savedAt, value: entry.value },
        ...entries.filter((item) => item?.key !== key),
      ].slice(0, MAX_PERSISTED_AREAS);
      storage.setItem(PERSISTED_CACHE_KEY, JSON.stringify(next));
    } catch {
      // Offline support must not break live loading if storage is blocked or full.
    }
  }

  async function fetchJsonWithTimeout(url, options, parentSignal, timeoutMs) {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        if (error.name !== "SyntaxError") throw error;
      }
      return { ok: response.ok, status: response.status, payload };
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
    if (error.name === "AbortError") return "Истекло время ожидания ответа сервиса цен.";
    if (error instanceof TypeError) return "Браузеру недоступен ответ сервиса цен. Проверьте соединение и адрес запуска приложения.";
    return error.message || "Не удалось получить сведения о ценах.";
  }

  function normalizeStation(station) {
    const lat = toNumber(station?.lat ?? station?.latitude);
    const lon = toNumber(station?.lon ?? station?.lng ?? station?.longitude);
    if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return null;
    }

    const fuels = {};
    for (const { code, label } of supportedFuels) {
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
        price: price > 0 ? price : null,
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

  function boundsToQuery({ south, west, north, east }) {
    const value = [south, west, north, east].map((n) => Number(n.toFixed(4))).join(",");
    return { key: value, value };
  }

  function normalizeOsmStation(element) {
    const tags = element.tags || {};
    const lat = toNumber(element.lat ?? element.center?.lat);
    const lon = toNumber(element.lon ?? element.center?.lon);
    if (lat === null || lon === null) return null;

    const fuels = {};
    for (const { code, label, osm: tag } of supportedFuels) {
      const value = String(tags[tag] || "").toLowerCase();
      fuels[code] = {
        label,
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
        const response = await fetchJsonWithTimeout(url, { method: "GET", referrerPolicy: "origin" }, pairController.signal, 6000);
        if (!response.ok) throw new Error(`OpenStreetMap ответил с ошибкой (${response.status}).`);
        const { payload } = response;
        if (!Array.isArray(payload?.elements)) throw new Error("OpenStreetMap вернул данные в неизвестном формате.");
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
    snapshotPromise ??= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "data/moscow-stations.snapshot.fallback.js";
      script.onload = () => {
        script.remove();
        const data = globalThis.FUELWISE_MOSCOW_STATIONS;
        if (Array.isArray(data?.stations)) resolve(data);
        else reject(new Error("Неизвестный формат резервного списка АЗС."));
      };
      script.onerror = () => {
        script.remove();
        reject(new Error("Не удалось прочитать резервный список АЗС."));
      };
      document.head.append(script);
    }).catch((error) => {
      snapshotPromise = null;
      throw error;
    });
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
      fallbackReason: "Показаны координаты из резервного списка. Цены и наличие не обновлялись.",
    };
  }

  function fromCache(entry, stale = false) {
    const elapsed = Math.max(0, Math.floor((Date.now() - entry.savedAt) / 1000));
    const stations = entry.value.stations.map((station) => {
      const fuels = {};
      for (const [code, fuel] of Object.entries(station.fuels)) {
        fuels[code] = { ...fuel };
        for (const key of ["freshnessSeconds", "availabilityFreshnessSeconds"]) {
          if (Number.isFinite(fuel[key])) fuels[code][key] += elapsed;
        }
      }
      return { ...station, fuels };
    });
    return { ...entry.value, stations, cacheHit: true, stale: stale || Boolean(entry.value.stale) };
  }

  async function getStationsInBounds(bounds, signal, forceRefresh = false, priceTimeoutMs = 18_000) {
    const query = boundsToQuery(bounds);
    let cached = cache.get(query.key);
    if (cached?.value.source !== "Gde-Benzin") {
      const saved = readPersistedStations(query.key);
      if (saved) {
        cached = saved;
        cache.set(query.key, saved);
      }
    }
    if (!forceRefresh && cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
      return fromCache(cached);
    }

    let result;
    try {
      const url = apiUrl();
      url.searchParams.set("bbox", query.value);
      const response = await fetchJsonWithTimeout(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      }, signal, priceTimeoutMs);
      if (!response.ok) {
        const sourceMessage = typeof response.payload?.error === "string" ? response.payload.error : "";
        if (response.status === 401 || response.status === 403) {
          throw new Error(`Сервис цен отказал в доступе (HTTP ${response.status}).`);
        }
        if (response.status === 429) throw new Error("Сервис цен ограничил частоту запросов (HTTP 429).");
        throw new Error(`Ошибка сервиса цен (HTTP ${response.status}). ${sourceMessage}`.trim());
      }

      const { payload } = response;
      if (!Array.isArray(payload?.stations)) throw new Error("Источник цен вернул данные в неизвестном формате.");
      const checkedAt = new Date().toISOString();
      result = {
        stations: payload.stations.map(normalizeStation).filter(Boolean),
        count: Number.isFinite(Number(payload.count)) ? Number(payload.count) : payload.stations.length,
        truncated: Boolean(payload.truncated),
        checkedAt,
        lastOnlineSuccessAt: checkedAt,
        source: "Gde-Benzin",
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      const priceIssue = apiFailureMessage(error);
      if (cached?.value.source === "Gde-Benzin" && cached.value.stations.length) {
        return {
          ...fromCache(cached, true),
          priceIssue,
          fallbackReason: "Показан ранее сохранённый список АЗС. Цены и наличие могут быть устаревшими.",
        };
      }
      try {
        result = await getOsmStations(query, signal);
        result.fallbackReason = result.count
          ? "Показаны координаты АЗС из OpenStreetMap. Цены и текущее наличие не подтверждены."
          : "OpenStreetMap не вернул станций в выбранной области.";
      } catch (osmError) {
        if (signal?.aborted) throw osmError;
        if (cached?.value?.stations?.length) {
          return { ...fromCache(cached, true), priceIssue };
        }
        try {
          result = await getSnapshotStations(query);
        } catch (snapshotError) {
          throw new Error(`${priceIssue} ${osmError.message} ${snapshotError.message}`);
        }
      }
      result.priceIssue = priceIssue;
      result.lastOnlineSuccessAt = cached?.value?.lastOnlineSuccessAt || null;
    }
    signal?.throwIfAborted();
    const cacheEntry = { savedAt: Date.now(), value: result };
    if (result.source === "Gde-Benzin") {
      cache.set(query.key, cacheEntry);
      persistStations(query.key, cacheEntry);
    } else if (cache.get(query.key)?.value.source !== "Gde-Benzin") {
      cache.set(query.key, cacheEntry);
    }
    return result;
  }

  ns.liveFuelStationsService = { getStationsInBounds };
})();
