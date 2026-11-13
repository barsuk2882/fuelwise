// Точка входа: связывает форму, сервисы, расчёты, карту и хранилище.
(() => {
  const { ui, map, storage, validation, optimizer, routingService, geocodingService, fuelStationsService } =
    globalThis.FuelWise;

  const DEFAULT_VEHICLE = { consumption: "7.5", currentFuel: "12", tankCapacity: "50", fuelType: "AI-95", pricePerLiter: "" };
  const DEFAULT_PRIORITY = "balanced";

  const NO_MAP_MESSAGE =
    "Карта недоступна. Введите адреса и воспользуйтесь поиском; расчёты и история продолжают работать.";
  const ROUTE_NOT_FOUND_MESSAGE = "Не удалось построить маршрут. Выберите другие точки";
  const STORAGE_FAILED_MESSAGE = "Не удалось сохранить данные: хранилище браузера недоступно или заполнено.";

  const state = {
    points: { start: null, end: null },
    searchTokens: { start: 0, end: 0 },
    fuelTypes: [],
    pickTarget: null,
    calculationToken: 0, // не даёт позднему сетевому ответу перерисовать изменённую поездку
    trip: null, // { vehicle, routes, variants, selectedKey, historyId }
    renderToken: 0, // отсекает устаревшие результаты при быстром переключении вариантов
  };

  function getFuelTypes(stations) {
    return [...new Set(stations.flatMap((station) => station.fuelTypes.map((fuel) => fuel.type)))].sort();
  }

  // Показывает выбранный вариант в блоках результата и на карте.
  async function showSelectedVariant() {
    const token = ++state.renderToken;
    const { vehicle, routes, variants, selectedKey } = state.trip;
    const variant = variants.find(({ key }) => key === selectedKey);

    const [stations, nearbyStations] = await Promise.all([
      optimizer.getRecommendedStations(
        variant.route,
        vehicle.fuelType,
        vehicle.currentFuel,
        vehicle.consumption,
        vehicle.tankCapacity,
      ),
      fuelStationsService.getNearbyStations(variant.route.geometry, vehicle.fuelType, optimizer.MAX_DETOUR_KM),
    ]);

    if (token !== state.renderToken) {
      return;
    }

    ui.renderWarnings(optimizer.buildTripWarnings(variant, vehicle));
    ui.renderResults({ variants, selectedKey, stations, onSelectVariant: selectVariant });
    map.showTrip({
      route: variant.route,
      otherRoutes: routes.filter((route) => route.id !== variant.route.id),
      stations: nearbyStations,
      stopIds: new Set(variant.stops.map(({ id }) => id)),
      recommendedIds: new Set(stations.map(({ id }) => id)),
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
    return id;
  }

  async function selectVariant(key) {
    if (!state.trip) return;
    state.trip.selectedKey = key;
    const variant = state.trip.variants.find((item) => item.key === key);
    if (!variant) return;

    // В истории хранится вариант, на котором остановился пользователь.
    storage.updateHistoryEntry(state.trip.historyId, getHistoryFields(variant));
    refreshHistory();
    await showSelectedVariant();
  }

  function clearTrip() {
    state.calculationToken += 1;
    state.renderToken += 1;
    state.trip = null;
    ui.setCalculating(false);
    ui.hideResults();
    map.clearTrip();
  }

  // keepHistoryEntry: пересчёт после правки заправок не создаёт новую запись в истории.
  async function calculateTrip({ keepHistoryEntry = false, routeOverride = null } = {}) {
    stopPicking();
    const calculationToken = ++state.calculationToken;
    const locations = { start: state.points.start, end: state.points.end };
    const historyIdToKeep = keepHistoryEntry ? state.trip?.historyId ?? null : null;
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
      ui.setCalculating(false);
      return;
    }
    const { vehicle, errors } = validation.validateTrip(input);

    if (Object.keys(errors).length) {
      clearTrip();
      ui.showFieldErrors(errors);
      const hasInvalidConsumption = errors.consumption === validation.INVALID_CONSUMPTION_MESSAGE;
      ui.renderWarnings(
        hasInvalidConsumption ? [{ type: "danger", text: validation.INVALID_CONSUMPTION_MESSAGE }] : [],
      );
      ui.setCalculating(false);
      return;
    }

    ui.setCalculating(true);
    try {
      const route = routeOverride || await routingService.getRoute(locations.start, locations.end);
      if (calculationToken !== state.calculationToken) return;

      const routes = [route, ...(await routingService.getAlternativeRoutes(route))];
      if (calculationToken !== state.calculationToken) return;
      const variants = await optimizer.buildTripVariants(routes, vehicle, vehicle.pricePerLiter);
      if (calculationToken !== state.calculationToken) return;
      const selected = variants.find(({ key }) => key === input.priority);
      if (!selected) throw new Error("Не удалось подготовить варианты поездки. Повторите расчёт.");
      const historyId = historyIdToKeep ?? saveToHistory(input, vehicle, selected, locations);

      state.trip = {
        vehicle,
        routes,
        variants,
        selectedKey: selected.key,
        historyId,
      };
      await showSelectedVariant();
      if (calculationToken !== state.calculationToken) return;
      if (!keepHistoryEntry) {
        ui.revealMap();
      }
    } catch (error) {
      if (calculationToken !== state.calculationToken) return;
      console.error("Ошибка расчёта поездки:", error);
      clearTrip();
      ui.renderWarnings([{ type: "danger", text: error?.message || ROUTE_NOT_FOUND_MESSAGE }]);
    } finally {
      if (calculationToken === state.calculationToken) ui.setCalculating(false);
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
    state.points[target] = location;
    const current = ui.getTripInput();
    ui.setPoints(target === "start" ? location.name : current.startPoint, target === "end" ? location.name : current.endPoint);
    ui.clearLocationChoices(target);
    ui.setMapStatus(`Точка ${target === "start" ? "А" : "Б"} выбрана: ${location.name}`);
    map.setLocations([state.points.start, state.points.end].filter(Boolean));
    ui.clearFieldErrors(document.getElementById("trip-form"));
    clearTrip();
  }

  function handlePointTextChanged(target) {
    const value = document.getElementById(`${target}-point`).value.trim();
    if (state.points[target]?.name !== value) state.points[target] = null;
    state.searchTokens[target] += 1;
    ui.clearLocationChoices(target);
    clearTrip();
  }

  function handleSwapPoints() {
    const { startPoint, endPoint } = ui.getTripInput();
    const start = state.points.start;
    state.points.start = state.points.end;
    state.points.end = start;
    ui.setPoints(endPoint, startPoint);
    ui.clearLocationChoices("start");
    ui.clearLocationChoices("end");
    clearTrip();
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
    const current = ui.getTripInput();
    if (state.pickTarget === "start") {
      state.points.start = location;
      ui.setPoints(location.name, current.endPoint);
    } else {
      state.points.end = location;
      ui.setPoints(current.startPoint, location.name);
    }
    stopPicking();
    ui.clearLocationChoices(state.points.start === location ? "start" : "end");
    clearTrip();
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
    ui.clearFieldErrors();
    ui.setPoints("", "");
    state.points = { start: null, end: null };
    ui.clearLocationChoices("start");
    ui.clearLocationChoices("end");
    ui.setPriority(DEFAULT_PRIORITY);
    ui.setVehicleInput(storage.loadVehicle() ?? DEFAULT_VEHICLE);
    ui.setVehicleStatus("");
    ui.renderWarnings([]);
    clearTrip();
  }

  function refreshHistory() {
    ui.renderHistory(storage.loadHistory(), { onRepeat: repeatFromHistory, onDelete: deleteHistoryEntry });
  }

  function deleteHistoryEntry(id) {
    storage.removeHistoryEntry(id);
    refreshHistory();
  }

  function handleClearHistory() {
    if (confirm("Удалить всю историю расчётов?")) {
      storage.clearHistory();
      refreshHistory();
    }
  }

  async function repeatFromHistory(entry) {
    clearTrip();
    if (!entry.startLocation || !entry.endLocation || !entry.route?.geometry?.length) {
      ui.showAppError("Этот расчёт сохранён в старом формате и не содержит координат маршрута. Постройте маршрут заново.");
      return;
    }
    ui.showAppError("");
    state.points = { start: entry.startLocation, end: entry.endLocation };
    ui.setPoints(entry.startLocation.name, entry.endLocation.name);
    map.setLocations([entry.startLocation, entry.endLocation]);
    ui.setVehicleInput(entry);
    ui.setPriority(entry.variantKey);
    await calculateTrip({ routeOverride: entry.route });
  }

  function isDarkThemeActive() {
    const { theme } = document.documentElement.dataset;
    return theme ? theme === "dark" : true;
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

    let reloadedForUpdate = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloadedForUpdate) return;
      reloadedForUpdate = true;
      location.reload();
    });

    navigator.serviceWorker
      .register("service-worker.js", { updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch((error) => {
        console.warn("Офлайн-режим недоступен:", error);
      });
  }

  async function init() {
    ui.bindEvents({
      onCalculate: calculateTrip,
      onLocationSearch: handleLocationSearch,
      onPointTextChanged: handlePointTextChanged,
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
    refreshHistory();

    if (!map.initMap("map", handleLocationPicked)) {
      ui.setMapStatus(NO_MAP_MESSAGE);
    }
    // Карта города и реальные АЗС изолированы от расчётной демо-карты.
    // Если внешний источник недоступен, запуск приложения продолжается.
    try {
      globalThis.FuelWise.moscowStationsMap?.init();
    } catch (error) {
      console.warn("Карта заправок недоступна:", error);
    }

    try {
      const stations = await fuelStationsService.getAllStations();
      state.fuelTypes = getFuelTypes(stations);

      ui.populateFuelTypes(state.fuelTypes);
      ui.setVehicleInput(storage.loadVehicle() ?? DEFAULT_VEHICLE);
      ui.setCalculating(false);
    } catch (error) {
      console.error("Ошибка начальной загрузки:", error);
      ui.showAppError("Не удалось загрузить список видов топлива. Обновите страницу или проверьте локальные файлы приложения.");
    }
  }

  init();
})();
