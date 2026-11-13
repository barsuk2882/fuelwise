// Поиск адреса выполняется только после явного действия пользователя.
(() => {
  const ns = (globalThis.FuelWise ??= {});
  const SEARCH_URL = "https://nominatim.openstreetmap.org/search";
  const CACHE_KEY = "fuelwise.v3.geocodeCache.v2";
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const MAX_CACHE_ITEMS = 30;
  const MIN_INTERVAL_MS = 1100;
  let lastRequestAt = 0;
  let requestQueue = Promise.resolve();

  function readCache() {
    try {
      const value = JSON.parse(localStorage.getItem(CACHE_KEY) || "[]");
      return Array.isArray(value) ? value.filter((entry) =>
        entry && typeof entry.query === "string" && Number.isFinite(entry.savedAt) && Array.isArray(entry.results),
      ) : [];
    } catch {
      return [];
    }
  }

  function getCached(query) {
    const normalized = cacheKey(query);
    // Пустые ответы не храним как успешный кэш: база адресов может обновиться.
    const entry = readCache().find((item) => item.query === normalized && item.results.length > 0);
    return entry && Date.now() - entry.savedAt < CACHE_TTL_MS ? entry.results : null;
  }

  function saveCache(query, results) {
    if (!results.length) return;
    const normalized = cacheKey(query);
    const next = readCache().filter((entry) => entry.query !== normalized && Date.now() - entry.savedAt < CACHE_TTL_MS);
    next.unshift({ query: normalized, savedAt: Date.now(), results });
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(next.slice(0, MAX_CACHE_ITEMS)));
    } catch {
      // Поиск остаётся доступен, даже если хранилище браузера заполнено или выключено.
    }
  }

  function placeLabel(place) {
    const address = place.address || {};
    const parts = [
      place.name && place.name !== place.display_name ? place.name : "",
      [address.road, address.house_number].filter(Boolean).join(", "),
      address.neighbourhood,
      address.suburb,
      address.city || address.town || address.village,
    ].filter(Boolean);
    const unique = [...new Set(parts)];
    return unique.slice(0, 4).join(", ") || String(place.display_name || "Найденное место").split(",").slice(0, 3).join(", ");
  }

  function cacheKey(value) {
    return expandAddressAbbreviations(String(value ?? ""))
      .toLocaleLowerCase("ru")
      .replace(/ё/gu, "е")
      .replace(/[.,;:]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  }

  function expandAddressAbbreviations(query) {
    const replacements = [
      [/(^|[\s,])пр\s*[-‐‑–—.]?\s*д(?=$|[\s,.;:])/giu, "$1проезд"],
      [/(^|[\s,])пр\s*[-‐‑–—.]?\s*т(?=$|[\s,.;:])/giu, "$1проспект"],
      [/(^|[\s,])просп?\.(?=$|[\s,.;:])/giu, "$1проспект"],
      [/(^|[\s,])ул\.(?=$|[\s,.;:])/giu, "$1улица"],
      [/(^|[\s,])ш\.(?=$|[\s,.;:])/giu, "$1шоссе"],
      [/(^|[\s,])наб\.(?=$|[\s,.;:])/giu, "$1набережная"],
      [/(^|[\s,])пер\.(?=$|[\s,.;:])/giu, "$1переулок"],
      [/(^|[\s,])пл\.(?=$|[\s,.;:])/giu, "$1площадь"],
      [/(^|[\s,])корп\.(?=$|[\s,.;:])/giu, "$1корпус"],
      [/(^|[\s,])стр\.(?=$|[\s,.;:])/giu, "$1строение"],
      [/(^|[\s,])д\.(?=\s*\d)/giu, "$1дом"],
      [/(^|[\s,])мкр\.(?=$|[\s,.;:])/giu, "$1микрорайон"],
      [/(^|[\s,])р\s*[-‐‑–—.]\s*н(?=$|[\s,.;:])/giu, "$1район"],
    ];

    return replacements.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), query)
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildSearchQuery(query) {
    const expanded = expandAddressAbbreviations(query);
    const hasMoscow = /(^|[\s,])москва(?=$|[\s,.;:])/iu;
    return hasMoscow.test(expanded) ? expanded : `${expanded}, Москва`;
  }

  function normalizeComparable(value) {
    return String(value ?? "")
      .toLocaleLowerCase("ru")
      .replace(/ё/gu, "е")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  }

  function getPlaceType(place) {
    const type = String(place.addresstype || place.type || place.class || "").toLocaleLowerCase("ru");
    const labels = {
      house: "дом",
      building: "здание",
      road: "улица",
      residential: "жилой район",
      neighbourhood: "район",
      suburb: "район",
      city: "город",
      town: "город",
      village: "посёлок",
      amenity: "организация",
      shop: "магазин",
      railway: "железнодорожный объект",
      station: "станция",
    };
    return labels[type] || "объект карты";
  }

  function scorePlace(place, query) {
    const address = place.address || {};
    const queryText = normalizeComparable(query);
    const addressText = normalizeComparable([
      place.name,
      place.display_name,
      address.road,
      address.house_number,
      address.building,
      address.neighbourhood,
      address.suburb,
      address.city,
      address.town,
      address.village,
    ].filter(Boolean).join(" "));
    const numbers = [...new Set(queryText.match(/\b\d+[\p{L}]?(?:[/-]\d+[\p{L}]?)?\b/gu) || [])];
    const words = [...new Set(queryText.split(" ").filter((word) =>
      word.length > 2 && !["москва", "район", "город", "дом", "корпус", "строение", "улица", "ул", "проспект", "проезд", "переулок", "шоссе", "площадь"].includes(word),
    ))];
    let score = 0;
    let matchedNumbers = 0;
    let matchedWords = 0;

    for (const number of numbers) {
      if (addressText.includes(number)) {
        score += 14;
        matchedNumbers += 1;
      } else {
        score -= 8;
      }
    }
    for (const word of words) {
      if (addressText.includes(word)) {
        score += 3;
        matchedWords += 1;
      }
    }
    if (address.house_number && numbers.some((number) => normalizeComparable(address.house_number).includes(number))) score += 18;
    if (address.road && queryText.includes(normalizeComparable(address.road))) score += 12;

    return {
      score,
      matchHint: numbers.length && matchedNumbers === numbers.length
        ? "Номер совпал — проверьте улицу и корпус"
        : matchedWords >= 2
          ? "Похожее совпадение — проверьте полный адрес"
          : "Проверьте адрес перед выбором",
    };
  }

  function formatAddressDetail(place) {
    const address = place.address || {};
    const parts = [
      [address.road, address.house_number].filter(Boolean).join(", "),
      address.neighbourhood,
      address.suburb,
      address.city || address.town || address.village,
    ].filter(Boolean);
    const unique = [...new Set(parts)];
    return unique.join(" · ") || String(place.display_name || "Адрес в источнике не указан").split(",").slice(0, 4).join(", ").trim();
  }

  async function waitForSlot() {
    const waitMs = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastRequestAt = Date.now();
  }

  function queuedFetch(url) {
    const request = requestQueue.then(async () => {
      await waitForSlot();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
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

  async function searchLocation(rawQuery) {
    const query = String(rawQuery ?? "").trim().replace(/\s+/g, " ");
    if (query.length < 3) {
      throw new Error("Введите адрес или название места (не менее трёх символов).");
    }

    const cached = getCached(query);
    if (cached) return cached;

    const url = new URL(SEARCH_URL);
    url.searchParams.set("q", buildSearchQuery(query));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("limit", "10");
    url.searchParams.set("viewbox", "36.9,56.1,38.1,55.3");
    url.searchParams.set("bounded", "1");
    url.searchParams.set("accept-language", "ru");

    let response;
    try {
      response = await queuedFetch(url);
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Поиск адреса не ответил вовремя. Проверьте соединение и повторите попытку.");
      }
      throw new Error("Не удалось связаться с поиском адресов. Проверьте интернет и попробуйте снова.");
    }
    if (response.status === 429) {
      throw new Error("Поиск адресов временно ограничил запросы. Подождите и повторите поиск позже.");
    }
    if (!response.ok) {
      throw new Error(`Поиск адресов ответил с ошибкой (${response.status}). Попробуйте позже.`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Поиск адресов вернул ответ в неизвестном формате.");
    }
    if (!Array.isArray(payload)) {
      throw new Error("Поиск адресов вернул ответ в неизвестном формате.");
    }

    const results = payload.map((place) => {
      const lat = Number(place.lat);
      const lon = Number(place.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
      const { score, matchHint } = scorePlace(place, query);
      return {
        id: `${place.osm_type || "place"}-${place.osm_id || `${lat.toFixed(6)}-${lon.toFixed(6)}`}`,
        name: placeLabel(place),
        addressDetail: formatAddressDetail(place),
        objectType: getPlaceType(place),
        matchHint,
        score,
        lat,
        lon,
        source: "Nominatim",
      };
    }).filter(Boolean).sort((left, right) => right.score - left.score);

    if (results.length) saveCache(query, results);
    return results;

  }

  ns.geocodingService = { searchLocation };
})();
