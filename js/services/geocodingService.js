// Поиск адреса выполняется только после явного действия пользователя.
(() => {
  const ns = (globalThis.FuelWise ??= {});
  const SEARCH_URL = "https://nominatim.openstreetmap.org/search";
  const CACHE_KEY = "fuelwise.v3.geocodeCache.v4";
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
    const expanded = expandAddressAbbreviations(String(value ?? ""));
    const structured = parseStructuredAddress(expanded);
    return normalizeComparable(structured
      ? `${structured.city} ${structured.house} ${normalizeStreetForCache(structured.street)}`
      : expanded);
  }

  function normalizeStreetForCache(value) {
    const parts = normalizeComparable(value).split(" ").filter(Boolean);
    const streetTypes = new Set(["улица", "проспект", "проезд", "шоссе", "набережная", "переулок", "бульвар", "аллея", "площадь"]);
    const typeIndex = parts.findIndex((part) => streetTypes.has(part));
    if (typeIndex < 0) return parts.join(" ");
    const [type] = parts.splice(typeIndex, 1);
    return [...parts, type].join(" ");
  }

  function expandAddressAbbreviations(query) {
    const replacements = [
      [/(^|[\s,])пр\s*[-‐‑–—.]?\s*д(?=$|[\s,.;:])/giu, "$1проезд"],
      [/(^|[\s,])пр\s*[-‐‑–—.]?\s*кт(?=$|[\s,.;:])/giu, "$1проспект"],
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
      [/(^|[\s,])г\.(?=$|[\s,.;:])/giu, "$1город"],
      [/(^|[\s,])б\s*[-‐‑–—.]\s*р\.(?=$|[\s,.;:])/giu, "$1бульвар"],
    ];

    return replacements.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), query)
      .replace(/\s+/g, " ")
      .trim();
  }

  const MOSCOW_AREA_CITIES = [
    "Зеленоград", "Москва", "Химки", "Мытищи", "Балашиха", "Подольск", "Красногорск",
    "Одинцово", "Люберцы", "Домодедово", "Королёв", "Реутов", "Видное", "Щёлково",
    "Долгопрудный", "Пушкино", "Лобня", "Жуковский", "Электросталь", "Ногинск",
    "Орехово-Зуево", "Сергиев Посад",
  ];

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function extractCity(query, fallbackToMoscow = true) {
    const normalized = normalizeComparable(query);
    const city = MOSCOW_AREA_CITIES.find((city) => {
      const phrase = normalizeComparable(city).split(" ").map(escapeRegExp).join("\\s+");
      return new RegExp(`(?:^|\\s)(?:город\\s+)?${phrase}(?=$|\\s)`, "u").test(normalized);
    });
    return city || (fallbackToMoscow ? "Москва" : null);
  }

  function stripKnownLocalities(query) {
    let result = String(query ?? "");
    for (const locality of [...MOSCOW_AREA_CITIES].sort((a, b) => b.length - a.length)) {
      const localityPattern = new RegExp(`(?:^|[,\\s])(?:город\\s+)?${escapeRegExp(locality)}(?=$|[,\\s])`, "giu");
      result = result.replace(localityPattern, " ");
    }
    return result
      .replace(/(?:^|[,\s])(?:россия|рф|russian federation)(?=$|[,\s])/giu, " ")
      .replace(/\s+/gu, " ")
      .replace(/^[,\s]+|[,\s]+$/gu, "")
      .replace(/[,\s]{2,}/gu, ", ")
      .trim();
  }

  const HOUSE_NUMBER_PART = String.raw`\d+(?:\/\d+)?[\p{L}]?`;
  const HOUSE_SUFFIX_PATTERN = new RegExp(
    String.raw`(?:^|[,\s])((?:дом\s*)?${HOUSE_NUMBER_PART}(?:(?:[,\s]*(?:корпус|корп\.?|к)\s*${HOUSE_NUMBER_PART})|(?:[,\s]*(?:строение|стр\.?|с)\s*${HOUSE_NUMBER_PART}))*)\s*$`,
    "iu",
  );

  function parseHouseValue(value) {
    let normalized = expandAddressAbbreviations(String(value ?? ""))
      .toLocaleLowerCase("ru")
      .replace(/ё/gu, "е")
      .replace(/^[,\s]*дом\s+/iu, "")
      .replace(/[.,]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();

    // Канонизируем варианты, которые обычно встречаются в российском адресе.
    normalized = normalized
      .replace(new RegExp(String.raw`(${HOUSE_NUMBER_PART})\s*(?:корпус|корп|к)\s*(${HOUSE_NUMBER_PART})`, "giu"), "$1 корпус $2")
      .replace(new RegExp(String.raw`(${HOUSE_NUMBER_PART})\s*(?:строение|стр|с)\s*(${HOUSE_NUMBER_PART})`, "giu"), "$1 строение $2");

    const match = normalized.match(new RegExp(
      String.raw`^(${HOUSE_NUMBER_PART})(?:\s*корпус\s*(${HOUSE_NUMBER_PART}))?(?:\s*строение\s*(${HOUSE_NUMBER_PART}))?$`,
      "iu",
    ));
    if (!match) return null;
    const house = match[1];
    const corpus = match[2] || "";
    const building = match[3] || "";
    return { key: `${house}|${corpus}|${building}`, compact: `${house}${corpus ? `к${corpus}` : ""}${building ? `с${building}` : ""}` };
  }

  // Дом извлекается только из адресного суффикса. Числа в названии улицы
  // («60-летия Октября», «1-я Тверская») не считаются номером дома.
  function findHouseDesignation(value) {
    const cleaned = stripKnownLocalities(expandAddressAbbreviations(value));
    const match = HOUSE_SUFFIX_PATTERN.exec(cleaned);
    if (!match) return null;
    const prefix = cleaned.slice(0, match.index).replace(/[,\s]+$/gu, "").trim();
    const hasExplicitHouseWord = /^дом\s*/iu.test(match[1]);
    if (!prefix && !hasExplicitHouseWord) return null;
    return parseHouseValue(match[1]);
  }

  function parseStructuredAddress(query) {
    const expanded = expandAddressAbbreviations(query);
    const cleaned = stripKnownLocalities(expanded);
    const match = HOUSE_SUFFIX_PATTERN.exec(cleaned);
    if (!match) return null;

    const street = cleaned.slice(0, match.index).replace(/[,\s]+$/gu, "").trim();
    if (street.length < 2) return null;

    // Названия объектов и адрес с пояснением в скобках лучше оставить
    // свободным запросом, не выдавая весь текст за название улицы.
    if (/[()]/u.test(expanded) || /\b(?:тц|торговый центр|арена|метро|вокзал|аэропорт|магазин|бц|кафе|ресторан)\b/iu.test(expanded)) {
      return null;
    }
    const house = parseHouseValue(match[1]);
    if (!house) return null;
    return { street, house: house.compact, city: extractCity(query, false) };
  }

  function buildSearchUrl(query) {
    const url = new URL(SEARCH_URL);
    const structured = parseStructuredAddress(query);
    if (structured) {
      // Nominatim structured search принимает дом вместе с улицей в поле street.
      url.searchParams.set("street", `${structured.house} ${normalizeStreetForCache(structured.street)}`);
      if (structured.city) url.searchParams.set("city", structured.city);
      url.searchParams.set("country", "Россия");
    } else {
      const expanded = expandAddressAbbreviations(query);
      const withoutLocalities = stripKnownLocalities(expanded);
      const searchQuery = withoutLocalities ? `${withoutLocalities}, ${extractCity(query)}` : `${expanded}, ${extractCity(query)}`;
      url.searchParams.set("q", searchQuery);
    }
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("limit", "10");
    url.searchParams.set("viewbox", "36.9,56.1,38.1,55.3");
    url.searchParams.set("bounded", "1");
    url.searchParams.set("countrycodes", "ru");
    url.searchParams.set("accept-language", "ru");
    return url;
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
    // Сравниваем с выдачей Nominatim по той же нормализованной форме,
    // которую используем при построении поискового запроса. Иначе «ул.»
    // и «улица» дают ложное предупреждение для верного адреса.
    const comparableQuery = expandAddressAbbreviations(query);
    const queryText = normalizeComparable(comparableQuery);
    const addressParts = [
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
    ].filter(Boolean);
    const addressText = normalizeComparable(addressParts.join(" "));
    const addressNumbers = new Set(addressText.match(/\b\d+[\p{L}]?(?:[/-]\d+[\p{L}]?)?\b/gu) || []);
    const numbers = [...new Set(queryText.match(/\b\d+[\p{L}]?(?:[/-]\d+[\p{L}]?)?\b/gu) || [])];
    const requestedHouseNumber = findHouseDesignation(query);
    const actualHouseNumber = parseHouseValue(address.house_number);
    const houseNumberMatches = Boolean(
      requestedHouseNumber && actualHouseNumber && actualHouseNumber.key === requestedHouseNumber.key,
    );
    const structuredAddress = parseStructuredAddress(query);
    const roadQuery = structuredAddress?.street || queryText;
    const roadMatches = Boolean(address.road && normalizeComparable(roadQuery).includes(normalizeComparable(address.road)));
    const words = [...new Set(queryText.split(" ").filter((word) =>
      word.length > 2 && !["москва", "район", "город", "дом", "корпус", "строение", "улица", "ул", "проспект", "проезд", "переулок", "шоссе", "площадь"].includes(word),
    ))];
    let score = 0;
    let matchedNumbers = 0;
    let matchedWords = 0;

    for (const number of numbers) {
      if (addressNumbers.has(number)) {
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
    if (houseNumberMatches) score += 40;
    else if (requestedHouseNumber && actualHouseNumber) score -= 28;
    else if (requestedHouseNumber && !actualHouseNumber) score -= 18;
    if (roadMatches) score += 12;

    return {
      score,
      exactAddress: Boolean(requestedHouseNumber && houseNumberMatches && roadMatches),
      matchQuality: requestedHouseNumber
        ? houseNumberMatches && roadMatches ? "exact" : "warning"
        : roadMatches ? "street" : "warning",
      matchHint: requestedHouseNumber
        ? !actualHouseNumber
          ? "Источник не указал номер дома — проверьте точку на карте"
          : !houseNumberMatches
            ? "Номер дома в выдаче отличается от запроса — проверьте точку"
            : !roadMatches
              ? "Номер совпал, но название улицы не подтверждено"
              : "Улица и номер дома совпали с запросом"
        : roadMatches
          ? ""
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

    const url = buildSearchUrl(query);

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
      const { score, exactAddress, matchQuality, matchHint } = scorePlace(place, query);
      return {
        id: `${place.osm_type || "place"}-${place.osm_id || `${lat.toFixed(6)}-${lon.toFixed(6)}`}`,
        name: placeLabel(place),
        addressDetail: formatAddressDetail(place),
        objectType: getPlaceType(place),
        matchHint,
        score,
        exactAddress,
        matchQuality,
        lat,
        lon,
        source: "Nominatim",
      };
    }).filter(Boolean).sort((left, right) => Number(right.exactAddress) - Number(left.exactAddress) || right.score - left.score);

    if (results.length) saveCache(query, results);
    return results;

  }

  ns.geocodingService = { searchLocation };
})();
