// Leaflet-карта города, выбранных точек, дорожного маршрута и доступных АЗС.
(() => {
  const ns = (globalThis.FuelWise ??= {});
  const CITY_CENTER = [55.751244, 37.618423];
  const ROUTE_CASING_STYLE = { color: "#ffffff", weight: 13, opacity: 0.98, lineCap: "round", lineJoin: "round" };
  const ROUTE_STYLE = { color: "#00a8dc", weight: 7, opacity: 1, lineCap: "round", lineJoin: "round" };
  const ALTERNATIVE_STYLE = { color: "#85948e", weight: 4, opacity: 0.72, dashArray: "7 9" };
  const STATION_MARKER_COLOR = "#f59e0b";

  let map = null;
  let routeLayer = null;
  let stationLayer = null;
  let onLocationPicked = null;
  let isPickModeActive = false;
  let currentRouteBounds = null;

  function isAvailable() {
    return map !== null;
  }

  function initMap(containerId, handleLocationPicked) {
    if (typeof L === "undefined" || !L.map) return false;
    try {
      map = L.map(containerId, { zoomControl: true, attributionControl: true, minZoom: 8, maxZoom: 19 })
        .setView(CITY_CENTER, 11);
      ns.mapTiles.addResilientBaseLayer(map, (message) => ns.ui.setMapStatus(message));
      routeLayer = L.layerGroup().addTo(map);
      stationLayer = L.layerGroup().addTo(map);
      onLocationPicked = handleLocationPicked;
      map.on("click", handleMapClick);
      new ResizeObserver(() => map?.invalidateSize({ animate: false })).observe(document.getElementById(containerId));
      return true;
    } catch {
      map = null;
      return false;
    }
  }

  function handleMapClick(event) {
    if (!isPickModeActive || typeof onLocationPicked !== "function") return;
    const lat = Number(event.latlng.lat.toFixed(6));
    const lon = Number(event.latlng.lng.toFixed(6));
    onLocationPicked({ name: `Точка на карте (${lat}, ${lon})`, lat, lon, source: "map" });
  }

  function setPickMode(isActive) {
    if (!isAvailable()) return;
    isPickModeActive = Boolean(isActive);
    map.getContainer().style.cursor = isPickModeActive ? "crosshair" : "";
  }

  function createPin(location, letter, modifier) {
    const icon = L.divIcon({
      className: "",
      html: `<div class="map-pin ${modifier}">${letter}</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
    return L.marker([location.lat, location.lon], { icon, title: location.name, zIndexOffset: 500 });
  }

  function createStationPopup(station) {
    const popup = document.createElement("div");
    popup.className = "map-popup";
    const title = document.createElement("strong");
    title.textContent = station.name;
    popup.append(title);

    for (const text of [station.brand, station.address, station.fuel?.pricePerLiter == null
      ? "Цена не опубликована"
      : `${station.fuel.type}: ${ns.ui.formatPrice(station.fuel.pricePerLiter)} за литр`,
    station.fuel?.available === true ? "Есть отметка о наличии" : "Наличие топлива не подтверждено"]) {
      if (!text) continue;
      const line = document.createElement("span");
      line.textContent = text;
      popup.append(line);
    }
    if (station.mapUrl) {
      const link = document.createElement("a");
      link.href = station.mapUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Источник станции";
      popup.append(link);
    }
    return popup;
  }

  function showTrip({ route, otherRoutes = [], stations = [], stopIds = new Set() }) {
    if (!isAvailable()) return;
    routeLayer.clearLayers();
    stationLayer.clearLayers();

    for (const otherRoute of otherRoutes) {
      L.polyline(otherRoute.geometry, ALTERNATIVE_STYLE).addTo(routeLayer);
    }
    L.polyline(route.geometry, ROUTE_CASING_STYLE).addTo(routeLayer);
    const routeLine = L.polyline(route.geometry, ROUTE_STYLE).addTo(routeLayer);
    createPin(route.start, "А", "").addTo(routeLayer);
    createPin(route.end, "Б", "map-pin--end").addTo(routeLayer);

    for (const station of stations) {
      const isStop = stopIds.has(station.id);
      L.circleMarker([station.lat, station.lon], {
        radius: isStop ? 10 : 9,
        color: "#ffffff",
        weight: 3,
        fillColor: STATION_MARKER_COLOR,
        fillOpacity: 1,
      }).bindPopup(createStationPopup(station)).addTo(stationLayer);
    }

    currentRouteBounds = routeLine.getBounds();
    map.invalidateSize({ animate: false });
    map.fitBounds(currentRouteBounds, { padding: [28, 28], maxZoom: 14, animate: false });
  }

  function clearTrip() {
    if (!isAvailable()) return;
    routeLayer.clearLayers();
    stationLayer.clearLayers();
    currentRouteBounds = null;
    map.setView(CITY_CENTER, 11, { animate: false });
  }

  function setLocations(locations) {
    if (!isAvailable() || !Array.isArray(locations) || !locations.length) return;
    const points = locations.filter((location) => Number.isFinite(location?.lat) && Number.isFinite(location?.lon));
    if (points.length) {
      map.fitBounds(L.latLngBounds(points.map((point) => [point.lat, point.lon])), { padding: [28, 28], maxZoom: 14 });
    }
  }

  ns.map = { initMap, isAvailable, setLocations, setPickMode, showTrip, clearTrip };
})();
