// Работа с localStorage. Все данные хранятся строками (JSON.stringify / JSON.parse).
// Повреждённая запись не должна ломать приложение: она удаляется, возвращается значение по умолчанию.
(() => {
  const ns = (globalThis.FuelWise ??= {});

  const KEYS = {
    vehicle: "fuelwise.v3.vehicle",
    history: "fuelwise.v3.history",
    theme: "fuelwise.v3.theme",
  };

  const MAX_HISTORY_ITEMS = 10;

  function readJson(key, fallback, isValid) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) {
        return fallback;
      }

      const parsed = JSON.parse(raw);
      if (isValid(parsed)) {
        return parsed;
      }
      localStorage.removeItem(key);
    } catch {
      removeQuietly(key);
    }
    return fallback;
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

  // Удаляем устаревшие правки редактора: актуальные станции загружает отдельный сервис.
  removeQuietly("fuelwise.v2.stationOverrides");

  function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function isHistoryEntry(entry) {
    return isPlainObject(entry) && typeof entry.id === "string" && typeof entry.startName === "string";
  }

  function loadVehicle() {
    return readJson(KEYS.vehicle, null, isPlainObject);
  }

  function saveVehicle(vehicle) {
    return writeJson(KEYS.vehicle, vehicle);
  }

  function loadHistory() {
    return readJson(KEYS.history, [], Array.isArray).filter(isHistoryEntry);
  }

  function addHistoryEntry(entry) {
    return writeJson(KEYS.history, [entry, ...loadHistory()].slice(0, MAX_HISTORY_ITEMS));
  }

  function updateHistoryEntry(id, changes) {
    const history = loadHistory().map((entry) => (entry.id === id ? { ...entry, ...changes } : entry));
    return writeJson(KEYS.history, history);
  }

  function removeHistoryEntry(id) {
    return writeJson(KEYS.history, loadHistory().filter((entry) => entry.id !== id));
  }

  function clearHistory() {
    removeQuietly(KEYS.history);
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
