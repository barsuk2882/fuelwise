import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../js/services/geocodingService.js", import.meta.url), "utf8");

function makePlace({ id, road, house, name, type = "house", city = "Москва" }) {
  return {
    osm_type: "way",
    osm_id: id,
    lat: "55.75",
    lon: "37.61",
    name: name || `${road}, ${house}`,
    display_name: `${road}, ${house}, ${city}, Россия`,
    addresstype: type,
    address: { road, house_number: house, city, country: "Россия" },
  };
}

function loadService(responsePlaces) {
  const requests = [];
  const storage = new Map();
  let time = 1_000_000;
  const context = vm.createContext({
    URL,
    URLSearchParams,
    AbortController,
    Promise,
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, value); },
    },
    Date: { now: () => (time += 1_200) },
    setTimeout(callback) { callback(); return 1; },
    clearTimeout() {},
    fetch: async (url) => {
      requests.push(new URL(url));
      return { ok: true, status: 200, json: async () => responsePlaces };
    },
  });
  vm.runInContext(source, context, { filename: "geocodingService.js" });
  return { searchLocation: context.FuelWise.geocodingService.searchLocation, requests, storage };
}

test("дом с номером корпуса передаётся в Nominatim как структурированный адрес", async () => {
  const service = loadService([]);
  await service.searchLocation("ул. Бутырская, д. 10 корп. 2, Москва");
  const request = service.requests[0];
  assert.equal(request.searchParams.get("street"), "10к2 бутырская улица");
  assert.equal(request.searchParams.get("city"), "Москва");
  assert.equal(request.searchParams.get("country"), "Россия");
  assert.equal(request.searchParams.get("countrycodes"), "ru");
  assert.equal(request.searchParams.has("q"), false);
});

test("поиск названия места остаётся свободным запросом", async () => {
  const service = loadService([]);
  await service.searchLocation("Красная площадь, Москва");
  assert.equal(service.requests[0].searchParams.get("q"), "Красная площадь, Москва");
  assert.equal(service.requests[0].searchParams.has("street"), false);
});

test("точное совпадение улицы, дома и строения идёт выше похожих адресов", async () => {
  const places = [
    makePlace({ id: 10, road: "улица Варварка", house: "6", name: "Соседний дом" }),
    makePlace({ id: 11, road: "улица Варварка", house: "6с7", name: "Точный дом" }),
  ];
  const service = loadService(places);
  const results = await service.searchLocation("ул. Варварка, дом 6, строение 7, Москва");
  assert.match(results[0].name, /Точный дом/u, JSON.stringify(results));
  assert.match(results[0].matchHint, /совпали/iu);
  assert.match(results[1].matchHint, /отличается/iu);
});

test("варианты записи корпуса используют общий ключ кэша", async () => {
  const service = loadService([makePlace({ id: 21, road: "Бутырская улица", house: "10к2" })]);
  const first = await service.searchLocation("ул. Бутырская, д. 10 корп. 2, Москва");
  const second = await service.searchLocation("Москва, Бутырская улица, 10 корпус 2");
  assert.equal(service.requests.length, 1);
  assert.equal(first[0].name, second[0].name);
});

test("номер в названии улицы не принимается за номер дома", async () => {
  const service = loadService([makePlace({ id: 31, road: "проспект 60-летия Октября", house: "1" })]);
  const results = await service.searchLocation("пр-т 60-летия Октября, Москва");
  assert.equal(service.requests[0].searchParams.has("street"), false);
  assert.equal(results[0].matchHint.includes("Номер дома"), false);
});

test("адрес с городом Зеленоград не превращается в адрес Москвы", async () => {
  const service = loadService([]);
  await service.searchLocation("Панфиловский пр-т, 10, Зеленоград");
  const request = service.requests[0];
  assert.equal(request.searchParams.get("city"), "Зеленоград");
  assert.equal(request.searchParams.get("street"), "10 панфиловский проспект");
});

test("без явного города структурный запрос опирается на границы Москвы и области", async () => {
  const service = loadService([]);
  await service.searchLocation("Панфиловский пр-т, 10");
  const request = service.requests[0];
  assert.equal(request.searchParams.get("street"), "10 панфиловский проспект");
  assert.equal(request.searchParams.has("city"), false);
  assert.equal(request.searchParams.get("bounded"), "1");
});

test("улица Зеленоградская не определяется как город Зеленоград", async () => {
  const service = loadService([]);
  await service.searchLocation("Зеленоградская улица, 12, Москва");
  assert.equal(service.requests[0].searchParams.get("city"), "Москва");
  assert.equal(service.requests[0].searchParams.get("street"), "12 зеленоградская улица");
});

test("название объекта с уточнением в скобках остаётся свободным запросом", async () => {
  const service = loadService([]);
  await service.searchLocation("ВТБ Арена, Ленинградский проспект (дублёр), 36");
  assert.equal(service.requests[0].searchParams.has("street"), false);
  assert.match(service.requests[0].searchParams.get("q"), /ВТБ Арена.*Москва/u);
});

test("если источник не вернул номер дома, совпадение помечается как неподтверждённое", async () => {
  const place = makePlace({ id: 41, road: "Тверская улица", house: "1" });
  delete place.address.house_number;
  const service = loadService([place]);
  const results = await service.searchLocation("Тверская улица, 1, Москва");
  assert.match(results[0].matchHint, /не указал номер дома/iu);
});

test("повторное написание с тем же точным домом не отправляет второй запрос", async () => {
  const service = loadService([makePlace({ id: 51, road: "Тверская улица", house: "1" })]);
  await service.searchLocation("Тверская улица, дом 1, Москва");
  const result = await service.searchLocation("Москва, ул. Тверская, д. 1");
  assert.equal(service.requests.length, 1);
  assert.match(result[0].matchHint, /совпали/iu);
});
