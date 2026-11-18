// Формулы приложения: топливо, стоимость, время и геометрия маршрута.
// Модуль не знает о DOM, хранилище и демо-данных.
(() => {
  const ns = (globalThis.FuelWise ??= {});

  const EARTH_RADIUS_KM = 6371;

  const TRIP_SETTINGS = {
    refuelStopMinutes: 7, // сама заправка: подъезд, налив, оплата
    detourSpeedKmh: 40, // скорость на съезде с маршрута
    fuelReserveRatio: 0.1, // комфортный запас — доля от объёма бака
  };

  // Необходимое топливо = расстояние / 100 * расход на 100 км
  function calculateFuelNeeded(distanceKm, consumptionPer100Km) {
    return (distanceKm / 100) * consumptionPer100Km;
  }

  // Стоимость топлива = необходимое топливо * цена за литр
  function calculateFuelCost(fuelNeeded, pricePerLiter) {
    return fuelNeeded * pricePerLiter;
  }

  // Остаток топлива = топливо в баке + купленное топливо - необходимое топливо
  function calculateRemainingFuel(fuelInTank, boughtFuel, fuelNeeded) {
    return fuelInTank + boughtFuel - fuelNeeded;
  }

  function calculateReserveLiters(tankCapacity) {
    return tankCapacity * TRIP_SETTINGS.fuelReserveRatio;
  }

  // Съезд к заправке и возврат на маршрут.
  function calculateDetourKm(offRouteKm) {
    return offRouteKm * 2;
  }

  function calculateStopMinutes(offRouteKm) {
    const detourMinutes = (calculateDetourKm(offRouteKm) / TRIP_SETTINGS.detourSpeedKmh) * 60;
    return TRIP_SETTINGS.refuelStopMinutes + detourMinutes;
  }

  // Приводит значение к диапазону 0..1; при одинаковых границах все варианты равны.
  function normalize(value, min, max) {
    return max === min ? 0 : (value - min) / (max - min);
  }

  function toRadians(degrees) {
    return (degrees * Math.PI) / 180;
  }

  function haversineKm([lat1, lon1], [lat2, lon2]) {
    const deltaLat = toRadians(lat2 - lat1);
    const deltaLon = toRadians(lon2 - lon1);
    const a =
      Math.sin(deltaLat / 2) ** 2 +
      Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLon / 2) ** 2;

    return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
  }

  // Проекция точки на отрезок в локальной плоской системе координат (в километрах).
  // На длине одного отрезка маршрута кривизной поверхности можно пренебречь.
  function projectPointOnSegment(point, segmentStart, segmentEnd) {
    const kmPerDegreeLat = (Math.PI * EARTH_RADIUS_KM) / 180;
    const kmPerDegreeLon = kmPerDegreeLat * Math.cos(toRadians(segmentStart[0]));

    const segmentX = (segmentEnd[1] - segmentStart[1]) * kmPerDegreeLon;
    const segmentY = (segmentEnd[0] - segmentStart[0]) * kmPerDegreeLat;
    const pointX = (point[1] - segmentStart[1]) * kmPerDegreeLon;
    const pointY = (point[0] - segmentStart[0]) * kmPerDegreeLat;

    const lengthSquared = segmentX ** 2 + segmentY ** 2;
    const rawPosition = lengthSquared === 0
      ? 0
      : (pointX * segmentX + pointY * segmentY) / lengthSquared;
    const position = Math.min(1, Math.max(0, rawPosition));

    return {
      distanceKm: Math.hypot(pointX - position * segmentX, pointY - position * segmentY),
      position,
    };
  }

  // Возвращает расстояние от точки до линии маршрута и долю пути (0..1) до ближайшего места.
  // Доля, а не километры: длина дорог в данных больше длины упрощённой линии.
  function projectPointOnRoute(point, geometry) {
    const segmentLengths = geometry
      .slice(1)
      .map((vertex, index) => haversineKm(geometry[index], vertex));
    const totalLength = segmentLengths.reduce((sum, length) => sum + length, 0);

    let offRouteKm = Infinity;
    let lengthToClosest = 0;
    let passedLength = 0;

    segmentLengths.forEach((segmentLength, index) => {
      const projection = projectPointOnSegment(point, geometry[index], geometry[index + 1]);
      if (projection.distanceKm < offRouteKm) {
        offRouteKm = projection.distanceKm;
        lengthToClosest = passedLength + projection.position * segmentLength;
      }
      passedLength += segmentLength;
    });

    return {
      offRouteKm,
      fractionAlong: totalLength === 0 ? 0 : lengthToClosest / totalLength,
    };
  }

  ns.calculations = {
    TRIP_SETTINGS,
    calculateFuelNeeded,
    calculateFuelCost,
    calculateRemainingFuel,
    calculateReserveLiters,
    calculateDetourKm,
    calculateStopMinutes,
    normalize,
    haversineKm,
    projectPointOnRoute,
  };
})();
