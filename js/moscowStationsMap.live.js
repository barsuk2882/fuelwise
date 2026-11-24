// Отдельная карта реальных АЗС: ошибки сети не затрагивают расчёты и демо-карту.
(() => {
  const ns = (globalThis.FuelWise ??= {});
  const MOSCOW_CENTER = [55.751244, 37.618423];
  const MOSCOW_ZOOM = 11;
  const POPUP_GAP = 12;
  // Поля содержимого, рамка и нижний отступ карточки Leaflet.
  const POPUP_FRAME_WIDTH = 48;
  const POPUP_FRAME_HEIGHT = 50;
  let map = null;
  let stationLayer = null;
  let stations = [];
  let activeFilter = "all";
  let requestController = null;
  let requestTimer = null;
  let requestToken = 0;
  let lastRequestKey = "";

  function element(id) {
    return document.getElementById(id);
  }

  function setStatus(message, isError = false) {
    const status = element("moscow-stations-status");
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("map-status--error", isError);
  }

  function setCount(message) {
    const count = element("moscow-stations-count");
    if (count) count.textContent = message;
  }

  function setTileStatus(message) {
    const status = element("moscow-tile-status");
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle("map-status--error", message.startsWith("Не удалось"));
  }

  function formatFreshness(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "время обновления неизвестно";
    if (seconds < 60) return "обновлено меньше минуты назад";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `обновлено ${minutes} мин. назад`;
    const hours = Math.floor(minutes / 60);
    return `обновлено ${hours} ч. назад`;
  }

  function formatCheckedAt(value) {
    if (!value) return "время неизвестно";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "время неизвестно";
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    }).format(date);
  }

  function lastOnlineCheckText(result) {
    return result.lastOnlineSuccessAt
      ? `Последняя успешная проверка цен и наличия: ${formatCheckedAt(result.lastOnlineSuccessAt)}.`
      : "Подтверждённой онлайн-проверки цен и наличия нет.";
  }

  function makePopup(station) {
    const popup = document.createElement("div");
    popup.className = "map-popup live-station-popup";

    const title = document.createElement("strong");
    title.textContent = station.name;
    const brand = document.createElement("span");
    brand.textContent = station.brand;
    const address = document.createElement("span");
    address.textContent = station.address;
    popup.append(title, brand, address);

    const fuelRows = Object.values(station.fuels)
      .filter((fuel) => fuel.price !== null || fuel.available !== null)
      .map((fuel) => {
        const row = document.createElement("span");
        const priceText = fuel.price === null
          ? "цена не указана"
          : `${ns.ui.formatNumber(fuel.price, 2)} ₽/л`;
        const availableText = station.dataSource === "OpenStreetMap"
          ? fuel.available === true ? "вид топлива указан в карточке АЗС"
            : fuel.available === false ? "вид топлива не указан в карточке АЗС" : "сведения о виде топлива не указаны"
          : fuel.available === true ? "есть отметка о наличии"
            : fuel.available === false ? "есть отметка об отсутствии" : "наличие не подтверждено";
        row.textContent = `${fuel.label}: ${priceText}; ${availableText}; ${formatFreshness(fuel.freshnessSeconds ?? fuel.availabilityFreshnessSeconds)}`;
        return row;
      });

    if (fuelRows.length) {
      popup.append(...fuelRows);
    } else {
      const empty = document.createElement("span");
      empty.textContent = "Нет свежих сведений о ценах и наличии топлива.";
      popup.append(empty);
    }

    if (station.mapUrl) {
      const link = document.createElement("a");
      link.href = station.mapUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Открыть карточку станции";
      popup.append(link);
    }
    return popup;
  }

  function passesFilter(station) {
    const fuel = station.fuels[activeFilter];
    // Не скрываем станции из резервного списка: там нет достоверных сведений по видам топлива.
    return activeFilter === "all" || !fuel || fuel.price !== null || fuel.available !== false;
  }

  function stationPopupOptions() {
    const { x: width, y: height } = map.getSize();
    const mapTop = map.getContainer().getBoundingClientRect().top;
    const zoomBottom = map.zoomControl.getContainer().getBoundingClientRect().bottom;
    const creditsHeight = map.attributionControl.getContainer().offsetHeight;
    const top = Math.ceil(zoomBottom - mapTop) + POPUP_GAP;
    const bottom = creditsHeight + POPUP_GAP;
    return {
      maxWidth: Math.max(50, Math.min(330, width - POPUP_GAP * 2 - POPUP_FRAME_WIDTH)),
      maxHeight: Math.max(1, height - top - bottom - POPUP_FRAME_HEIGHT),
      autoPanPaddingTopLeft: [POPUP_GAP, top],
      autoPanPaddingBottomRight: [POPUP_GAP, bottom],
      keepInView: true,
    };
  }

  function resizeStationPopups() {
    const options = stationPopupOptions();
    stationLayer.eachLayer((marker) => {
      const popup = marker.getPopup();
      L.setOptions(popup, options);
      if (marker.isPopupOpen()) popup.update();
    });
  }

  function renderStationList() {
    const list = element("moscow-stations-list");
    if (!list) return;
    list.replaceChildren();

    const filterNote = element("live-map-filter-note");
    if (filterNote) {
      filterNote.hidden = activeFilter === "all";
    }

    const visible = stations.filter(passesFilter).slice(0, 8);
    for (const station of visible) {
      const item = document.createElement("button");
      item.className = "live-station-row";
      item.type = "button";
      item.addEventListener("click", () => {
        map.closePopup();
        map.setView([station.lat, station.lon], Math.max(map.getZoom(), 15), { animate: false });
        stationLayer?.eachLayer((marker) => {
          if (marker.options.stationId === station.id) marker.openPopup();
        });
      });

      const name = document.createElement("strong");
      name.textContent = station.name;
      const address = document.createElement("span");
      address.textContent = station.address;
      const firstPrice = activeFilter === "all" ? Object.values(station.fuels).find((fuel) => fuel.price !== null) : station.fuels[activeFilter];
      const detail = document.createElement("span");
      const isSnapshot = station.dataSource?.includes("резервный список");
      detail.textContent = firstPrice?.price != null
        ? `${firstPrice.label}: ${ns.ui.formatNumber(firstPrice.price, 2)} ₽/л · ${formatFreshness(firstPrice.freshnessSeconds)}`
        : isSnapshot
          ? "Вид топлива, цена и наличие не подтверждены"
          : station.dataSource === "OpenStreetMap" ? "Цена и наличие не указаны в OpenStreetMap" : "Цена не опубликована";
      item.append(name, address, detail);
      list.append(item);
    }
    list.hidden = visible.length === 0;
  }

  function renderMarkers() {
    if (!stationLayer) return;
    const visible = stations.filter(passesFilter);
    const popupOptions = stationPopupOptions();
    let openMarker = null;
    for (const marker of stationLayer.getLayers()) {
      if (marker.isPopupOpen()) openMarker = marker;
      else stationLayer.removeLayer(marker);
    }

    for (const station of visible) {
      const position = [station.lat, station.lon];
      const content = makePopup(station);
      if (openMarker?.options.stationId === station.id) {
        if (!openMarker.getLatLng().equals(position)) openMarker.setLatLng(position);
        if (!openMarker.getPopup().getContent().isEqualNode(content)) openMarker.setPopupContent(content);
        openMarker = null;
        continue;
      }
      const marker = L.circleMarker(position, {
        radius: 9,
        color: "#ffffff",
        weight: 3,
        fillColor: "#f59e0b",
        fillOpacity: 1,
        stationId: station.id,
      });
      marker.bindPopup(content, popupOptions);
      marker.addTo(stationLayer);
    }
    if (openMarker) stationLayer.removeLayer(openMarker);

    renderStationList();
  }

  function requestKey(bounds) {
    return [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()]
      .map((value) => value.toFixed(3)).join(",");
  }

  async function loadStations(force = false, priceTimeoutMs) {
    if (!map || !ns.liveFuelStationsService) return;
    const bounds = map.getBounds();
    const key = requestKey(bounds);
    if (!force && key === lastRequestKey) return;
    lastRequestKey = key;

    if (requestController) requestController.abort();
    requestController = new AbortController();
    const token = ++requestToken;
    setStatus("Загружаем заправки в области карты…");
    setCount("Загружаем…");

    try {
      const result = await ns.liveFuelStationsService.getStationsInBounds({
        south: bounds.getSouth(), west: bounds.getWest(), north: bounds.getNorth(), east: bounds.getEast(),
      }, requestController.signal, force, priceTimeoutMs);
      if (token !== requestToken) return;
      stations = result.stations;
      renderMarkers();

      const suffix = result.truncated ? " Уменьшите масштаб и нажмите «Обновить», чтобы получить более полный список." : "";
      setCount(`Найдено: ${result.count}`);
      if (result.priceIssue) {
        setStatus(`${result.priceIssue} ${result.fallbackReason} ${lastOnlineCheckText(result)}${suffix}`, true);
      } else if (!result.count) {
        setStatus("В этой области источник не вернул заправки. Попробуйте немного изменить масштаб или положение карты.");
      } else if (!stations.some((station) => Object.values(station.fuels).some((fuel) => fuel.price !== null))) {
        const origin = result.cacheHit ? "В сохранённом списке" : "В ответе сервиса";
        setStatus(`${origin} есть АЗС, но цены топлива не опубликованы. ${lastOnlineCheckText(result)}${suffix}`);
      } else if (result.cacheHit && result.source === "Gde-Benzin") {
        setStatus(`Показан сохранённый список АЗС из «Где бензин» (загружен ${formatCheckedAt(result.checkedAt)}). Возраст цен и наличия указан в карточках. Для запроса свежих данных нажмите «Обновить».${suffix}`);
      } else if (result.source === "OpenStreetMap") {
        setStatus(`Найдены реальные АЗС по данным OpenStreetMap. Цены и текущее наличие топлива в этом источнике не указаны. ${lastOnlineCheckText(result)}${suffix}`);
      } else {
        setStatus(`Данные получены из «Где бензин». Проверено ${formatCheckedAt(result.checkedAt)}; возраст цены и наличия показан в карточке каждой станции.${suffix}`);
      }
    } catch (error) {
      if (error.name === "AbortError" || token !== requestToken) return;
      stations = [];
      renderMarkers();
      lastRequestKey = "";
      setCount("Станции не загружены");
      setStatus(`${error.message || "Не удалось загрузить сведения о заправках."} История и расчёт расхода продолжают работать.`, true);
    }
  }

  function scheduleReload() {
    clearTimeout(requestTimer);
    requestTimer = setTimeout(() => loadStations(), 700);
  }

  function init() {
    const container = element("moscow-map");
    if (!container || typeof L === "undefined" || !L.map) {
      setCount("Карта недоступна");
      setStatus("Библиотека карты не загрузилась. Расчёты и история работают отдельно.", true);
      return false;
    }

    try {
      // Собственная подпись источников сохраняется, декоративный логотип Leaflet скрыт.
      map = L.map(container, { zoomControl: true, attributionControl: false, minZoom: 8, maxZoom: 18 })
        .setView(MOSCOW_CENTER, MOSCOW_ZOOM);
      L.control.attribution({ prefix: false }).addTo(map);
      ns.mapTiles.addResilientBaseLayer(map, setTileStatus);
      stationLayer = L.layerGroup().addTo(map);
      map.on("moveend", scheduleReload);
      map.on("resize", resizeStationPopups);
      new ResizeObserver(() => map.invalidateSize({ debounceMoveend: true })).observe(container);

      element("reload-moscow-stations")?.addEventListener("click", () => loadStations(true, 35_000));
      element("live-fuel-filter")?.addEventListener("change", (event) => {
        activeFilter = event.currentTarget.value;
        renderMarkers();
      });

      requestAnimationFrame(() => loadStations(true));
      return true;
    } catch {
      map = null;
      setCount("Карта недоступна");
      setStatus("Не удалось запустить карту. Расчёты и история работают отдельно.", true);
      return false;
    }
  }

  ns.moscowStationsMap = { init, loadStations };
})();
