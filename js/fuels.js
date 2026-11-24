(() => {
  const ns = (globalThis.FuelWise ??= {});
  // Сохранённые в истории названия также принимаются при чтении настроек.
  const types = [
    { code: "ai92", label: "АИ-92", legacy: "AI-92", osm: "fuel:octane_92" },
    { code: "ai95", label: "АИ-95", legacy: "AI-95", osm: "fuel:octane_95" },
    { code: "ai98", label: "АИ-98", legacy: "AI-98", osm: "fuel:octane_98" },
    { code: "ai100", label: "АИ-100", legacy: "AI-100", osm: "fuel:octane_100" },
    { code: "dt", label: "Дизель", legacy: "Diesel", osm: "fuel:diesel" },
    { code: "lpg", label: "LPG", legacy: "LPG" },
  ];
  function find(value) {
    return types.find((fuel) => [fuel.code, fuel.label, fuel.legacy].includes(value));
  }
  ns.fuels = { types, find };
})();
