// Отдельная карта реальных АЗС: ошибки сети не затрагивают расчёты и демо-карту.
(() => {
  const ns = (globalThis.FuelWise ??= {});
  const MOSCOW_CENTER = [55.751244, 37.618423];
  const MOSCOW_ZOOM = 11;
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
        map?.flyTo([station.lat, station.lon], Math.max(map.getZoom(), 15));
        stationLayer?.eachLayer((marker) => {
          if (marker.options.stationId === station.id) marker.openPopup();
        });
      });

      const name = document.createElement("strong");
      name.textContent = station.name;
      const address = document.createElement("span");
      address.textContent = station.address;
      const firstPrice = Object.values(station.fuels).find((fuel) => fuel.price !== null);
      const detail = document.createElement("span");
      const isSnapshot = station.dataSource?.includes("резервный список");
      detail.textContent = firstPrice
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
    stationLayer.clearLayers();
    const visible = stations.filter(passesFilter);

    for (const station of visible) {
      const marker = L.circleMarker([station.lat, station.lon], {
        radius: 9,
        color: "#ffffff",
        weight: 3,
        fillColor: "#f59e0b",
        fillOpacity: 1,
        stationId: station.id,
      });
      marker.bindPopup(makePopup(station), { maxWidth: 330 });
      marker.addTo(stationLayer);
    }

    renderStationList();
  }

  function requestKey(bounds) {
    return [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()]
      .map((value) => value.toFixed(3)).join(",");
  }

  async function loadStations(force = false) {
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
      const result = await ns.liveFuelStationsService.getStationsInBounds(bounds, requestController.signal, force);
      if (token !== requestToken) return;
      stations = result.stations;
      renderMarkers();

      const suffix = result.truncated ? " Уменьшите масштаб и нажмите «Обновить», чтобы получить более полный список." : "";
      setCount(`Найдено: ${result.count}`);
      setStatus(result.count
        ? result.source === "OpenStreetMap"
          ? `Найдены реальные АЗС по данным OpenStreetMap. Цены и текущее наличие топлива в этом источнике не указаны.${suffix}`
          : result.source === "Snapshot"
            ? result.fallbackReason
            : `Данные получены из «Где бензин». Возраст цены и наличия показан в карточке каждой станции.${suffix}`
        : "В этой области источник не вернул заправки. Попробуйте немного изменить масштаб или положение карты.");
      if (result.fallbackReason) {
        const message = result.source === "Snapshot"
          ? `Показаны координаты АЗС из резервного списка. Цены и наличие не обновлены. ${result.diagnostic || result.fallbackReason}`
          : result.fallbackReason;
        setStatus(`${message} ${suffix}`.trim());
      }
    } catch (error) {
      if (error.name === "AbortError" || token !== requestToken) return;
      const cached = ns.liveFuelStationsService.getCachedStations?.(bounds);
      if (cached?.stations?.length) {
        stations = cached.stations;
        renderMarkers();
        setCount(`Найдено: ${cached.count}`);
        setStatus(`Не удалось обновить источник. Показаны ранее загруженные станции; сведения могут быть устаревшими. ${error.message || ""}`.trim(), true);
        return;
      }
      stations = [];
      renderMarkers();
      lastRequestKey = "";
      setCount("Станции не загружены");
      setStatus(`${error.message || "Не удалось загрузить сведения о заправках."} Демо-расчёты и история продолжают работать.`, true);
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
      setStatus("Библиотека карты не загрузилась. Расчёты, демо-заправки и история работают отдельно.", true);
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

      element("reload-moscow-stations")?.addEventListener("click", () => loadStations(true));
      element("live-fuel-filter")?.addEventListener("change", (event) => {
        activeFilter = event.currentTarget.value;
        renderMarkers();
      });

      requestAnimationFrame(() => loadStations(true));
      return true;
    } catch {
      map = null;
      setCount("Карта недоступна");
      setStatus("Не удалось запустить карту. Расчёты, демо-заправки и история работают отдельно.", true);
      return false;
    }
  }

  ns.moscowStationsMap = { init, loadStations };
})();
