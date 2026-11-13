// Общая подложка для обеих карт с автоматическим резервным источником.
(() => {
  const ns = (globalThis.FuelWise ??= {});
  const SOURCES = [
    {
      name: "OpenStreetMap",
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    },
    {
      name: "MIERUNE",
      url: "https://tile.mierune.co.jp/mierune/{z}/{x}/{y}.png",
      attribution: '&copy; <a href="https://mierune.co.jp/">MIERUNE Inc.</a> · &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> · &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    },
  ];
  const TILE_TIMEOUT_MS = 6500;

  function addResilientBaseLayer(map, onStatus = () => {}) {
    if (typeof L === "undefined" || !L.tileLayer || !map) return null;

    let sourceIndex = 0;
    let activeLayer = null;
    let timeoutId = null;
    let requestNumber = 0;
    let receivedTile = false;
    let tileErrors = 0;
    let fallbackActivated = false;

    function clearTimer() {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    }

    function beginAttempt(layer, attemptNumber) {
      if (attemptNumber !== requestNumber) return;
      clearTimer();
      receivedTile = false;
      tileErrors = 0;
      timeoutId = setTimeout(() => {
        if (attemptNumber === requestNumber && !receivedTile) {
          advanceSource("тайлы не ответили вовремя");
        }
      }, TILE_TIMEOUT_MS);
    }

    function advanceSource(reason) {
      if (sourceIndex >= SOURCES.length - 1) {
        clearTimer();
        onStatus(`Не удалось загрузить карту: основной и резервный источники недоступны (${reason}). Проверьте соединение и обновите страницу.`);
        return;
      }

      clearTimer();
      requestNumber += 1;
      sourceIndex += 1;
      fallbackActivated = true;
      if (activeLayer) map.removeLayer(activeLayer);
      onStatus(`Основной источник карты не ответил. Подключаем резервную карту ${SOURCES[sourceIndex].name}…`);
      installSource();
    }

    function installSource() {
      const source = SOURCES[sourceIndex];
      const attemptNumber = ++requestNumber;
      receivedTile = false;
      tileErrors = 0;
      activeLayer = L.tileLayer(source.url, {
        minZoom: 0,
        maxZoom: 19,
        attribution: source.attribution,
      });

      activeLayer.on("loading", () => beginAttempt(activeLayer, attemptNumber));
      activeLayer.on("tileload", () => {
        if (attemptNumber !== requestNumber) return;
        receivedTile = true;
        clearTimer();
        onStatus(fallbackActivated
          ? `Подключена резервная карта ${source.name}.`
          : "");
      });
      activeLayer.on("tileerror", () => {
        if (attemptNumber === requestNumber) tileErrors += 1;
      });
      activeLayer.on("load", () => {
        if (attemptNumber === requestNumber && !receivedTile && tileErrors > 0) {
          advanceSource("сервер отклонил запросы тайлов");
        }
      });

      onStatus(`Загружаем карту (${source.name})…`);
      map.addLayer(activeLayer);
      if (activeLayer.isLoading?.()) beginAttempt(activeLayer, attemptNumber);
    }

    installSource();
    return {
      retry() {
        clearTimer();
        if (activeLayer) map.removeLayer(activeLayer);
        sourceIndex = 0;
        fallbackActivated = false;
        installSource();
      },
      getSourceName() {
        return SOURCES[sourceIndex].name;
      },
    };
  }

  ns.mapTiles = { addResilientBaseLayer };
})();
