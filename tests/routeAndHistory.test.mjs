import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const readScript = (file) => readFile(new URL("../js/" + file, import.meta.url), "utf8");
const [validation, routing, storage] = await Promise.all([
  readScript("validation.js"), readScript("services/routingService.js"), readScript("storage.js"),
]);

function trip(start, end) {
  const urls = [];
  const context = vm.createContext({ URL, FuelWise: { createRequestQueue: () => async (url) => {
    urls.push(url);
    return { ok: true, payload: { code: "Ok", routes: [{
      geometry: { coordinates: [[start.lon, start.lat], [end.lon, end.lat]] }, distance: 1000, duration: 150,
    }] } };
  } } });
  vm.runInContext(validation, context);
  vm.runInContext(routing, context);
  const input = { startPoint: start.name, endPoint: end.name, consumption: "8", currentFuel: "10",
    tankCapacity: "45", pricePerLiter: "", fuelType: "ai95" };
  const { errors } = context.FuelWise.validation.validateTrip(input, { start, end });
  return { errors, urls, request: () => context.FuelWise.routingService.getRoutes(start, end) };
}

const station = { name: "Вокзал", lat: 55.75, lon: 37.61 };
test("одноимённые объекты с разными координатами допускаются к построению маршрута", async () => {
  const t = trip(station, { ...station, lon: 37.65 });
  assert.deepEqual(Object.keys(t.errors), []);
  assert.equal((await t.request()).length, 1);
  assert.equal(t.urls.length, 1);
});

for (const offset of [0, 0.0000005]) {
  test(`разные подписи одной точки, отклонение ${offset}: ошибка поля Б без запроса OSRM`, async () => {
    const t = trip(station, { name: "Главный вход", lat: station.lat + offset, lon: station.lon });
    assert.match(t.errors.endPoint ?? "", /не могут совпадать/);
    await assert.rejects(t.request, /не могут совпадать/);
    assert.equal(t.urls.length, 0);
  });
}

const v5 = "fuelwise.v5.history";
const v3 = "fuelwise.v3.history";
const legacy = JSON.stringify([{ id: "old", startName: "Москва" }]);
function loadStore(data, rejectWrites = false) {
  const context = vm.createContext({ localStorage: {
    getItem: key => data.get(key) ?? null,
    setItem(key, value) {
      if (rejectWrites) throw Error("Запись запрещена");
      data.set(key, value);
    },
    removeItem: key => data.delete(key),
  } });
  vm.runInContext(storage, context);
  return context.FuelWise.storage;
}

for (const invalid of ["{", "{}"]) {
  test(`повреждённая история V5 (${invalid}): первое чтение и перезапуск дают одинаковую историю`, () => {
    const data = new Map([[v5, invalid], [v3, legacy]]);
    const store = loadStore(data);
    assert.equal(store.loadHistory()[0]?.id, "old");
    assert.equal(data.get(v5), legacy);
    assert.equal(loadStore(data).loadHistory()[0]?.id, "old");
    assert.equal(data.get(v3), legacy);
    assert.equal(store.clearHistory(), true);
    assert.equal(loadStore(data).loadHistory().length, 0);
    assert.equal(data.get(v3), legacy);
  });
}

test("нет пригодной резервной истории: возвращается пустой список", () => {
  const data = new Map([[v5, "{"], [v3, "{}"]]);
  assert.equal(loadStore(data).loadHistory().length, 0);
  assert.equal(loadStore(data).loadHistory().length, 0);
  assert.equal(data.get(v3), "{}");
});

test("при запрете записи восстановленный список доступен уже при первом чтении", () => {
  const data = new Map([[v5, "{"], [v3, legacy]]);
  const store = loadStore(data, true);
  assert.equal(store.loadHistory()[0]?.id, "old");
  assert.equal(store.loadHistory()[0]?.id, "old");
  assert.equal(data.get(v3), legacy);
});
