// Единая точка загрузки data/demo-data.json для всех сервисов.
// Файл читается один раз, результат переиспользуется.
(() => {
  const ns = (globalThis.FuelWise ??= {});

  const DATA_URL = "data/demo-data.json";
  const FALLBACK_SCRIPT_URL = "data/demo-data.fallback.js";

  let dataPromise = null;

  async function fetchDemoData() {
    const response = await fetch(DATA_URL);
    if (!response.ok) {
      throw new Error(`Файл демо-данных недоступен: ${response.status}`);
    }
    return response.json();
  }

  // При открытии через file:// браузер блокирует fetch, а обычный <script> разрешён.
  function loadFallbackScript() {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = FALLBACK_SCRIPT_URL;
      script.onload = () => resolve(globalThis.FUELWISE_DEMO_DATA);
      script.onerror = () => reject(new Error("Не удалось загрузить демо-данные"));
      document.head.append(script);
    });
  }

  function assertDemoData(data) {
    if (!Array.isArray(data?.routes) || !Array.isArray(data?.fuelStations)) {
      throw new Error("Файл демо-данных имеет неверный формат");
    }
    return data;
  }

  function getDemoData() {
    if (!dataPromise) {
      const source = location.protocol === "file:"
        ? loadFallbackScript()
        : fetchDemoData().catch(loadFallbackScript);

      dataPromise = source.then(assertDemoData).catch((error) => {
        dataPromise = null; // следующая попытка должна читать файл заново
        throw error;
      });
    }
    return dataPromise;
  }

  ns.demoDataLoader = { getDemoData };
})();
