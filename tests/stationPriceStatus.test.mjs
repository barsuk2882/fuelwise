import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const files = ["fuels", "calculations", "services/liveFuelStationsService.live", "services/fuelStationsService", "optimizer"];
const sources = await Promise.all(files.map((file) => readFile(new URL("../js/" + file + ".js", import.meta.url), "utf8")));
const bounds = { south: 55.7, west: 37.5, north: 55.8, east: 37.7 };
const station = { lat: 55.75, lon: 37.6, fuels: { ai95: true }, prices: { ai95: 60 } };
function setup(primary, backup = () => Response.json({ elements: [] })) {
  const context = vm.createContext({
    URL, TypeError, AbortController, setTimeout, clearTimeout, console,
    location: { href: "http://127.0.0.1:8880/" },
    fetch: (url) => url.pathname === "/api/stations" ? primary() : backup(),
    document: { createElement: () => ({ remove() {} }), head: { append: (script) => script.onload() } },
    FUELWISE_MOSCOW_STATIONS: { stations: [station], fetchedAt: "2026-01-01" },
  });
  for (const source of sources) vm.runInContext(source, context);
  return context.FuelWise;
}

for (const status of [401, 403, 429, 502]) {
  test("HTTP " + status + " остаётся виден при пустой выдаче OpenStreetMap", async () => {
    const ns = setup(() => Response.json({ error: "Ошибка" }, { status }));
    const data = await ns.liveFuelStationsService.getStationsInBounds(bounds);
    assert.equal(data.source, "OpenStreetMap");
    assert.equal(data.count, 0);
    assert.match(data.priceIssue, new RegExp("HTTP " + status));
    assert.match(data.fallbackReason, /не вернул станций/);
  });
}

test("ошибка сети без HTTP-статуса доходит до предупреждений поездки", async () => {
  const fail = () => { throw new TypeError("Failed to fetch"); };
  const ns = setup(fail, fail);
  const route = { id: "route", distanceKm: 5, durationMinutes: 7, geometry: [[55.75, 37.59], [55.75, 37.61]] };
  const vehicle = { consumption: 10, currentFuel: 5, tankCapacity: 50, fuelType: "ai95" };
  const [variant] = await ns.optimizer.buildTripVariants([route], vehicle, null);
  assert.equal(variant.coverage.source, "Snapshot");
  assert.equal(variant.fuelCost, null);
  const texts = ns.optimizer.buildTripWarnings(variant, vehicle).map(item => item.text).join(" ");
  assert.match(texts, /Браузеру недоступен ответ/);
  assert.doesNotMatch(texts, /403/);
});

test("сохранённые цены помечаются устаревшими с причиной отказа", async () => {
  let denied = false;
  const ns = setup(() => denied ? new Response(null, { status: 403 }) : Response.json({ stations: [station] }),
    () => { throw new TypeError("offline"); });
  const service = ns.liveFuelStationsService;
  const original = await service.getStationsInBounds(bounds);
  denied = true;
  const cached = await service.getStationsInBounds(bounds, undefined, true);
  assert.equal(cached.stale, true);
  assert.equal(cached.lastOnlineSuccessAt, original.lastOnlineSuccessAt);
  assert.match(cached.priceIssue, /HTTP 403/);
});

test("успешные пустые ответы и станции без положительной цены сохраняют статус источника", async () => {
  for (const stations of [[], [{ ...station, prices: {} }], [{ ...station, prices: { ai95: 0 } }]]) {
    const ns = setup(() => Response.json({ stations }));
    const result = await ns.liveFuelStationsService.getStationsInBounds(bounds);
    assert.equal(result.source, "Gde-Benzin");
    assert.equal(result.priceIssue, undefined);
    assert.equal(result.count, stations.length);
    if (stations.length) assert.equal(result.stations[0].fuels.ai95.price, null);
  }
});
