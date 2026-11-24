// Работа с localStorage. Все данные хранятся строками (JSON.stringify / JSON.parse).
// При повреждении записи V5 сразу читается проверенное резервное значение из V3.
(() => {
  const ns = (globalThis.FuelWise ??= {});

  const KEYS = {
    vehicle: "fuelwise.v5.vehicle",
    history: "fuelwise.v5.history",
    theme: "fuelwise.v5.theme",
  };

  const MAX_HISTORY_ITEMS = 10;

  function parseStoredValue(raw, isValid) {
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw);
      return isValid(value) ? value : null;
    } catch {
      return null;
    }
  }

  function readJson(key, fallback, isValid) {
    try {
      const raw = localStorage.getItem(key);
      const current = parseStoredValue(raw, isValid);
      if (current !== null) return current;

      const legacyKey = key.replace("fuelwise.v5.", "fuelwise.v3.");
      const recovered = parseStoredValue(localStorage.getItem(legacyKey), isValid) ?? fallback;
      if (raw !== null) {
        if (recovered === null) removeQuietly(key);
        else writeJson(key, recovered);
      }
      return recovered;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false; // хранилище переполнено или запрещено настройками браузера
    }
  }

  function removeQuietly(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Хранилище недоступно: удалять нечего, приложение работает без него.
    }
  }

  function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function validLocation(location) {
    return typeof location?.name === "string" && Number.isFinite(location.lat) &&
      Math.abs(location.lat) <= 90 && Number.isFinite(location.lon) && Math.abs(location.lon) <= 180;
  }

  function normalizeHistoryEntry(entry) {
    if (!isPlainObject(entry) || typeof entry.id !== "string" || typeof entry.startName !== "string") return null;
    const route = entry.route;
    const canRepeat = validLocation(entry.startLocation) && validLocation(entry.endLocation) &&
      validLocation(route?.start) && validLocation(route?.end) &&
      Number.isFinite(route.distanceKm) && route.distanceKm > 0 && Number.isFinite(route.durationMinutes) &&
      Array.isArray(route.geometry) && route.geometry.length >= 2 &&
      route.geometry.every((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]) &&
        Math.abs(point[0]) <= 90 && Math.abs(point[1]) <= 180);
    const normalized = { ...entry, route: canRepeat ? route : null };
    for (const key of ["distanceKm", "consumption", "fuelCost"]) {
      const value = entry[key];
      normalized[key] = (typeof value === "number" || (typeof value === "string" && value.trim())) &&
        Number.isFinite(Number(value)) ? Number(value) : null;
    }
    for (const key of ["endName", "fuelType", "variantLabel"]) {
      if (typeof normalized[key] !== "string") normalized[key] = "нет данных";
    }
    return normalized;
  }

  function loadVehicle() {
    return readJson(KEYS.vehicle, null, isPlainObject);
  }

  function saveVehicle(vehicle) {
    return writeJson(KEYS.vehicle, vehicle);
  }

  function loadHistory() {
    return readJson(KEYS.history, [], Array.isArray).map(normalizeHistoryEntry).filter(Boolean);
  }

  function addHistoryEntry(entry) {
    return writeJson(KEYS.history, [entry, ...loadHistory()].slice(0, MAX_HISTORY_ITEMS));
  }

  function updateHistoryEntry(id, changes) {
    const history = loadHistory();
    const entry = history.find((item) => item.id === id);
    if (!entry) return false;
    Object.assign(entry, changes);
    return writeJson(KEYS.history, history);
  }

  function removeHistoryEntry(id) {
    return writeJson(KEYS.history, loadHistory().filter((entry) => entry.id !== id));
  }

  function clearHistory() {
    return writeJson(KEYS.history, []);
  }

  function saveTheme(theme) {
    return writeJson(KEYS.theme, theme);
  }

  ns.storage = {
    loadVehicle,
    saveVehicle,
    loadHistory,
    addHistoryEntry,
    updateHistoryEntry,
    removeHistoryEntry,
    clearHistory,
    saveTheme,
  };
})();
