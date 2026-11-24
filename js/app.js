// Точка входа: связывает форму, сервисы, расчёты, карту и хранилище.
(() => {
  const { ui, map, storage, validation, optimizer, routingService, geocodingService, fuels } =
    globalThis.FuelWise;

  const DEFAULT_VEHICLE = { consumption: "7.5", currentFuel: "12", tankCapacity: "50", fuelType: "ai95", pricePerLiter: "" };
  const DEFAULT_PRIORITY = "balanced";

  const NO_MAP_MESSAGE =
    "Карта недоступна. Введите адреса и воспользуйтесь поиском; расчёты и история продолжают работать.";
  const ROUTE_NOT_FOUND_MESSAGE = "Не удалось построить маршрут. Выберите другие точки";
  const STORAGE_FAILED_MESSAGE = "Не удалось сохранить данные: хранилище браузера недоступно или заполнено.";

  const state = {
    points: { start: null, end: null },
    searchTokens: { start: 0, end: 0 },
    pickTarget: null,
    routeNeedsRecalculation: false,
    calculationToken: null, // токен только текущего незавершённого расчёта
    trip: null, // { vehicle, routes, variants, selectedKey, historyId }
  };

  function showSelectedVariant() {
    const { vehicle, routes, variants, selectedKey } = state.trip;
    const variant = variants.find(({ key }) => key === selectedKey);
    ui.setPriority(selectedKey);
    ui.renderWarnings(optimizer.buildTripWarnings(variant, vehicle));
    ui.renderResults({
      variants, selectedKey, stations: variant.recommendations,
      tankCapacity: vehicle.tankCapacity, onSelectVariant: selectVariant,
    });
    map.showTrip({
      route: variant.route,
      otherRoutes: routes.filter((route) => route.id !== variant.route.id),
      stations: variant.coverage.stations,
      stopIds: new Set(variant.stops.map(({ id }) => id)),
    });
  }

  function getHistoryFields(variant, vehicle = state.trip?.vehicle) {
    return {
      distanceKm: variant.distanceKm,
      fuelCost: variant.fuelCost,
      variantKey: variant.key,
      variantLabel: variant.label,
      fuelNeeded: variant.fuelNeeded,
      remainingFuel: variant.remainingFuel,
      pricePerLiter: vehicle?.pricePerLiter ?? null,
      route: {
        id: variant.route.id,
        name: variant.route.name,
        distanceKm: variant.route.distanceKm,
        durationMinutes: variant.route.durationMinutes,
        geometry: variant.route.geometry,
        source: variant.route.source,
        start: variant.route.start,
        end: variant.route.end,
      },
    };
  }

  function saveToHistory(input, vehicle, variant, locations) {
    const id = `calc_${Date.now()}`;

    const isSaved = storage.addHistoryEntry({
      id,
      createdAt: new Date().toISOString(),
      startName: input.startPoint,
      endName: input.endPoint,
      startLocation: locations.start,
      endLocation: locations.end,
      consumption: vehicle.consumption,
      currentFuel: vehicle.currentFuel,
      tankCapacity: vehicle.tankCapacity,
      fuelType: vehicle.fuelType,
      ...getHistoryFields(variant, vehicle),
    });

    ui.showAppError(isSaved ? "" : STORAGE_FAILED_MESSAGE);
    refreshHistory();
    return isSaved ? id : null;
  }

  function selectVariant(key) {
    if (!state.trip) return;
    const variant = state.trip.variants.find((item) => item.key === key);
    if (!variant) return;
    state.trip.selectedKey = key;

    // В истории хранится вариант, на котором остановился пользователь.
    if (state.trip.historyId) {
      ui.showAppError(storage.updateHistoryEntry(state.trip.historyId, getHistoryFields(variant)) ? "" : STORAGE_FAILED_MESSAGE);
    }
    refreshHistory();
    showSelectedVariant();
  }

  function clearTrip() {
    state.calculationToken = null;
    state.trip = null;
    ui.setCalculating(false);
    ui.hideResults();
    ui.renderWarnings([]);
    map.clearTrip();
  }

  async function calculateTrip({ routeOverride = null } = {}) {
    stopPicking();
    state.routeNeedsRecalculation = false;
    const calculationToken = Symbol();
    state.calculationToken = calculationToken;
    const locations = { start: state.points.start, end: state.points.end };
    ui.clearFieldErrors();

    const input = ui.getTripInput();
    const pointErrors = {};
    if (!locations.start || locations.start.name !== input.startPoint) {
      pointErrors.startPoint = "Найдите точку А и выберите её из списка результатов или на карте";
    }
    if (!locations.end || locations.end.name !== input.endPoint) {
      pointErrors.endPoint = "Найдите точку Б и выберите её из списка результатов или на карте";
    }
    if (Object.keys(pointErrors).length) {
      clearTrip();
      ui.showFieldErrors(pointErrors);
      return;
    }
    const { vehicle, errors } = validation.validateTrip(input, locations);

    if (Object.keys(errors).length) {
      clearTrip();
      ui.showFieldErrors(errors);
      const hasInvalidConsumption = errors.consumption === validation.INVALID_CONSUMPTION_MESSAGE;
      ui.renderWarnings(
        hasInvalidConsumption ? [{ type: "danger", text: validation.INVALID_CONSUMPTION_MESSAGE }] : [],
      );
      return;
    }

    ui.setCalculating(true);
    try {
      const routes = routeOverride ? [routeOverride] : await routingService.getRoutes(locations.start, locations.end);
      if (calculationToken !== state.calculationToken) return;
      const variants = await optimizer.buildTripVariants(routes, vehicle, vehicle.pricePerLiter);
      if (calculationToken !== state.calculationToken) return;
      const selected = variants.find(({ key }) => key === input.priority);
      if (!selected) throw new Error("Не удалось подготовить варианты поездки. Повторите расчёт.");
      const historyId = saveToHistory(input, vehicle, selected, locations);

      state.trip = {
        vehicle,
        routes,
        variants,
        selectedKey: selected.key,
        historyId,
      };
      showSelectedVariant();
      if (calculationToken !== state.calculationToken) return;
      ui.revealMap();
    } catch (error) {
      if (calculationToken !== state.calculationToken) return;
      console.error("Ошибка расчёта поездки:", error);
      clearTrip();
      ui.renderWarnings([{ type: "danger", text: error?.message || ROUTE_NOT_FOUND_MESSAGE }]);
    } finally {
      if (calculationToken === state.calculationToken) {
        state.calculationToken = null;
        ui.setCalculating(false);
      }
    }
  }

  async function handleLocationSearch(target) {
    const query = document.getElementById(`${target}-point`).value.trim();
    const token = ++state.searchTokens[target];
    ui.renderLocationChoices(target, [], null, "Ищем адрес. Первый запрос может занять несколько секунд…");
    ui.clearFieldErrors(document.getElementById("trip-form"));
    try {
      const locations = await geocodingService.searchLocation(query);
      if (token !== state.searchTokens[target]) return;
      if (!locations.length) {
        ui.renderLocationChoices(target, [], null, "Точного совпадения нет. Проверьте название улицы, номер дома и корпус. Если объект отсутствует в адресных данных, укажите точку на карте.");
        return;
      }
      ui.renderLocationChoices(target, locations, (location) => handleLocationSelected(target, location));
    } catch (error) {
      if (token === state.searchTokens[target]) ui.renderLocationChoices(target, [], null, error.message);
    }
  }

  function handleLocationSelected(target, location) {
    stopPicking();
    invalidateLocationSearch(target);
    state.routeNeedsRecalculation = false;
    state.points[target] = location;
    const current = ui.getTripInput();
    ui.setPoints(target === "start" ? location.name : current.startPoint, target === "end" ? location.name : current.endPoint);
    ui.setMapStatus(`Точка ${target === "start" ? "А" : "Б"} выбрана: ${location.name}`);
    ui.clearFieldErrors(document.getElementById("trip-form"));
    clearTrip();
    map.setLocations(state.points);
  }

  function handlePointTextChanged(target) {
    const value = document.getElementById(`${target}-point`).value.trim();
    const hadTrip = Boolean(state.trip) || state.routeNeedsRecalculation;
    if (state.points[target]?.name !== value) state.points[target] = null;
    invalidateLocationSearch(target);
    clearTrip();
    map.setLocations(state.points);
    if (hadTrip) {
      state.routeNeedsRecalculation = true;
      ui.renderWarnings([{ type: "info", text: "Маршрут изменён. Рассчитайте поездку заново." }]);
    }
  }

  function handleVehicleChanged() {
    ui.setVehicleStatus("");
    if (!state.trip && state.calculationToken === null) return;
    clearTrip();
    map.setLocations(state.points);
    state.routeNeedsRecalculation = true;
    ui.renderWarnings([{ type: "info", text: "Параметры автомобиля изменены. Рассчитайте поездку заново." }]);
  }

  function handleSwapPoints() {
    const { startPoint, endPoint } = ui.getTripInput();
    const start = state.points.start;
    state.points.start = state.points.end;
    state.points.end = start;
    ui.setPoints(endPoint, startPoint);
    invalidateAllLocationSearches();
    clearTrip();
    map.setLocations(state.points);
  }

  function invalidateLocationSearch(target) {
    state.searchTokens[target] += 1;
    ui.clearLocationChoices(target);
  }

  function invalidateAllLocationSearches() {
    invalidateLocationSearch("start");
    invalidateLocationSearch("end");
  }

  function stopPicking() {
    if (state.pickTarget) {
      state.pickTarget = null;
      ui.setPickButtons(null);
      ui.setMapStatus("");
      map.setPickMode(false);
    }
  }

  function handlePickToggle(target) {
    if (!map.isAvailable()) {
      ui.setMapStatus(NO_MAP_MESSAGE);
      return;
    }

    if (state.pickTarget === target) {
      stopPicking();
      return;
    }

    state.pickTarget = target;
    ui.setPickButtons(target);
    ui.setMapStatus(`Нажмите на карте в месте, которое станет точкой ${target === "start" ? "А" : "Б"}.`);
    map.setPickMode(true);
  }

  function handleLocationPicked(location) {
    if (state.pickTarget) handleLocationSelected(state.pickTarget, location);
  }

  function handleSaveVehicle() {
    ui.clearFieldErrors(document.getElementById("trip-form"));

    const input = ui.getTripInput();
    const { errors } = validation.validateVehicle(input);
    if (Object.keys(errors).length) {
      ui.setVehicleStatus("");
      ui.showFieldErrors(errors);
      return;
    }

    const { consumption, currentFuel, tankCapacity, fuelType, pricePerLiter } = input;
    const isSaved = storage.saveVehicle({ consumption, currentFuel, tankCapacity, fuelType, pricePerLiter });
    ui.setVehicleStatus(isSaved ? "Параметры сохранены и подставятся при следующем открытии." : STORAGE_FAILED_MESSAGE);
  }

  function handleReset() {
    stopPicking();
    state.routeNeedsRecalculation = false;
    invalidateAllLocationSearches();
    ui.clearFieldErrors();
    ui.setPoints("", "");
    state.points = { start: null, end: null };
    ui.setPriority(DEFAULT_PRIORITY);
    ui.setVehicleInput(storage.loadVehicle() ?? DEFAULT_VEHICLE);
    ui.setVehicleStatus("");
    ui.renderWarnings([]);
    clearTrip();
    map.resetView();
  }

  function refreshHistory() {
    ui.renderHistory(storage.loadHistory(), {
      onRepeat: repeatFromHistory,
      onDelete: deleteHistoryEntry,
    });
  }

  function deleteHistoryEntry(id) {
    const saved = storage.removeHistoryEntry(id);
    if (saved && state.trip?.historyId === id) state.trip.historyId = null;
    ui.showAppError(saved ? "" : STORAGE_FAILED_MESSAGE);
    refreshHistory();
  }

  function handleClearHistory() {
    if (confirm("Удалить всю историю расчётов?")) {
      const saved = storage.clearHistory();
      if (saved && state.trip) state.trip.historyId = null;
      ui.showAppError(saved ? "" : STORAGE_FAILED_MESSAGE);
      refreshHistory();
    }
  }

  async function repeatFromHistory(entry) {
    clearTrip();
    invalidateAllLocationSearches();
    if (!entry.startLocation || !entry.endLocation || !entry.route?.geometry?.length) {
      ui.showAppError("Этот расчёт сохранён в старом формате и не содержит координат маршрута. Постройте маршрут заново.");
      return;
    }
    ui.showAppError("");
    state.points = { start: entry.startLocation, end: entry.endLocation };
    ui.setPoints(entry.startLocation.name, entry.endLocation.name);
    map.setLocations(state.points);
    ui.setVehicleInput(entry);
    ui.setPriority(entry.variantKey);
    await calculateTrip({ routeOverride: entry.route });
  }

  function isDarkThemeActive() {
    const { theme } = document.documentElement.dataset;
    return theme !== "light";
  }

  function syncThemeColor(theme = isDarkThemeActive() ? "dark" : "light") {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === "dark" ? "#0c121a" : "#edf1f5";
  }

  function handleThemeToggle() {
    const theme = isDarkThemeActive() ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    storage.saveTheme(theme);
    syncThemeColor(theme);
    ui.setThemeButton(theme === "dark");
  }

  function setupConnectionStatus() {
    const update = () => ui.setOffline(!navigator.onLine);
    addEventListener("online", update);
    addEventListener("offline", update);
    update();
  }

  // Service worker работает только по http(s); при запуске из файла он просто не нужен.
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || !location.protocol.startsWith("http")) return;

    navigator.serviceWorker
      .register("service-worker.js", { updateViaCache: "none" })
      .then((registration) => {
        const showUpdate = () => {
          if (registration.waiting && navigator.serviceWorker.controller) {
            document.getElementById("update-banner").hidden = false;
          }
        };
        showUpdate();
        registration.addEventListener("updatefound", () => {
          registration.installing?.addEventListener("statechange", showUpdate);
        });
      })
      .catch((error) => {
        console.warn("Офлайн-режим недоступен:", error);
      });
  }

  function init() {
    ui.bindEvents({
      onCalculate: calculateTrip,
      onLocationSearch: handleLocationSearch,
      onPointTextChanged: handlePointTextChanged,
      onVehicleChanged: handleVehicleChanged,
      onSwapPoints: handleSwapPoints,
      onPickToggle: handlePickToggle,
      onSaveVehicle: handleSaveVehicle,
      onReset: handleReset,
      onThemeToggle: handleThemeToggle,
      onExportHistory: () => ui.downloadHistoryCsv(storage.loadHistory()),
      onClearHistory: handleClearHistory,
    });

    ui.setThemeButton(isDarkThemeActive());
    syncThemeColor();
    setupConnectionStatus();
    registerServiceWorker();
    ui.populateFuelTypes(fuels.types);
    ui.setVehicleInput(storage.loadVehicle() ?? DEFAULT_VEHICLE);
    ui.setCalculating(false);
    refreshHistory();

    if (!map.initMap("map", handleLocationPicked)) {
      ui.setMapStatus(NO_MAP_MESSAGE);
    }
    // Карта города и реальные АЗС изолированы от карты маршрута.
    // Если внешний источник недоступен, запуск приложения продолжается.
    try {
      globalThis.FuelWise.moscowStationsMap?.init();
    } catch (error) {
      console.warn("Карта заправок недоступна:", error);
    }
  }

  init();
})();
