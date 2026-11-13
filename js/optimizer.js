// Выбор заправок и вариантов поездки: план дозаправок, три варианта, предупреждения.
(() => {
  const ns = (globalThis.FuelWise ??= {});
  const calc = () => ns.calculations;

  const OPTIMIZATION_WEIGHTS = {
    cost: 0.6,
    time: 0.4,
  };

  const MAX_DETOUR_KM = 5; // дальше этого заправка считается не «по пути»
  const MAX_RECOMMENDED_STATIONS = 5;
  const MIN_WORTHWHILE_PURCHASE_LITERS = 5; // ради меньшего объёма останавливаться нет смысла
  const MAX_REFUEL_STOPS = 10; // защита от зацикливания на некорректных данных

  const VARIANT_LABELS = {
    cheapest: "Дешевле",
    shortest: "Короче",
    fastest: "Быстрее",
    balanced: "Сбалансированно",
    distanceBalanced: "Баланс расстояния и времени",
  };

  const VARIANT_DESCRIPTIONS = {
    cheapest: "Минимальная рассчитанная стоимость топлива",
    shortest: "Минимальная длина маршрута; стоимость топлива неизвестна",
    fastest: "Минимальное время в пути",
    balanced: "Баланс рассчитанной стоимости топлива и времени",
    distanceBalanced: "Баланс длины маршрута и времени без оценки стоимости",
  };

  // Оценка «цена и удобство»: чем меньше, тем лучше. Веса те же, что у вариантов поездки.
  function addConvenienceScores(stations) {
    const prices = stations.map((station) => station.pricePerLiter);
    const minutes = stations.map((station) => station.extraMinutes);
    const [minPrice, maxPrice] = [Math.min(...prices), Math.max(...prices)];
    const [minMinutes, maxMinutes] = [Math.min(...minutes), Math.max(...minutes)];

    return stations.map((station) => ({
      ...station,
      score:
        OPTIMIZATION_WEIGHTS.cost * calc().normalize(station.pricePerLiter, minPrice, maxPrice) +
        OPTIMIZATION_WEIGHTS.time * calc().normalize(station.extraMinutes, minMinutes, maxMinutes),
    }));
  }

  // Заправки по пути с доступным топливом, дополненные данными о положении на маршруте.
  async function getUsableStations(route, fuelType) {
    const nearby = await ns.fuelStationsService.getNearbyStations(
      route.geometry,
      fuelType,
      MAX_DETOUR_KM,
    );

    const usable = nearby
      .filter((station) => station.fuel.available === true && Number.isFinite(station.fuel.pricePerLiter) && station.fuel.pricePerLiter > 0)
      .map((station) => ({
        ...station,
        pricePerLiter: station.fuel.pricePerLiter,
        kmFromStart: station.fractionAlong * route.distanceKm,
        detourKm: calc().calculateDetourKm(station.offRouteKm),
        extraMinutes: calc().calculateStopMinutes(station.offRouteKm),
      }))
      .sort((a, b) => a.kmFromStart - b.kmFromStart);

    return addConvenienceScores(usable);
  }

  // Сколько литров взять на заправке: до конца поездки с запасом, но не больше свободного места.
  function calculatePurchaseLiters(fuelOnArrival, fuelToFinish, tankCapacity) {
    const target = fuelToFinish + calc().calculateReserveLiters(tankCapacity);
    const freeSpace = tankCapacity - Math.max(fuelOnArrival, 0);
    return Math.max(0, Math.min(target - fuelOnArrival, freeSpace));
  }

  function getFuelToFinish(route, station, consumption) {
    const kmLeft = route.distanceKm - station.kmFromStart + station.offRouteKm;
    return calc().calculateFuelNeeded(kmLeft, consumption);
  }

  async function getRecommendedStations(route, fuelType, currentFuel, consumption, tankCapacity) {
    const stations = await getUsableStations(route, fuelType);
    const isRefuelNeeded =
      currentFuel < calc().calculateFuelNeeded(route.distanceKm, consumption);

    const recommended = stations.map((station) => {
      const kmToStation = station.kmFromStart + station.offRouteKm;
      const fuelOnArrival = currentFuel - calc().calculateFuelNeeded(kmToStation, consumption);
      const fuelToFinish = getFuelToFinish(route, station, consumption);
      const litersToBuy = isRefuelNeeded
        ? calculatePurchaseLiters(fuelOnArrival, fuelToFinish, tankCapacity)
        : 0;

      return {
        ...station,
        fuelOnArrival,
        isReachable: fuelOnArrival >= 0,
        litersToBuy,
        refuelCost: calc().calculateFuelCost(litersToBuy, station.pricePerLiter),
        coversTrip: !isRefuelNeeded || Math.max(fuelOnArrival, 0) + litersToBuy >= fuelToFinish,
      };
    });

    return recommended
      .sort((a, b) => Number(b.isReachable) - Number(a.isReachable) || a.score - b.score)
      .slice(0, MAX_RECOMMENDED_STATIONS);
  }

  const STOP_COMPARATORS = {
    cheapest: (a, b) => a.pricePerLiter - b.pricePerLiter || a.extraMinutes - b.extraMinutes,
    fastest: (a, b) => a.extraMinutes - b.extraMinutes || a.pricePerLiter - b.pricePerLiter,
    balanced: (a, b) => a.score - b.score,
  };

  // Выбирает следующую остановку среди достижимых заправок. Заправки, откуда можно
  // доехать до конца, важнее: они экономят лишнюю остановку.
  function pickNextStop(reachable, strategy, fuelAtPosition, position, route, vehicle) {
    const consumption = vehicle.consumption;
    const withFuelOnArrival = reachable.map((station) => ({
      station,
      fuelOnArrival:
        fuelAtPosition -
        calc().calculateFuelNeeded(station.kmFromStart - position + station.offRouteKm, consumption),
    }));

    const worthwhile = withFuelOnArrival.filter(
      ({ fuelOnArrival }) =>
        vehicle.tankCapacity - fuelOnArrival >= MIN_WORTHWHILE_PURCHASE_LITERS,
    );
    const options = worthwhile.length ? worthwhile : withFuelOnArrival;

    const finishing = options.filter(
      ({ station }) => getFuelToFinish(route, station, consumption) <= vehicle.tankCapacity,
    );
    const pool = finishing.length ? finishing : options;

    return [...pool].sort((a, b) => STOP_COMPARATORS[strategy](a.station, b.station))[0];
  }

  // Пошаговая симуляция поездки: едем, пока хватает топлива, и заправляемся по стратегии.
  function buildRefuelPlan(route, stations, vehicle, strategy) {
    const { consumption, currentFuel, tankCapacity } = vehicle;
    const stops = [];
    let fuel = currentFuel;
    let position = 0;

    while (stops.length < MAX_REFUEL_STOPS) {
      const fuelToEnd = calc().calculateFuelNeeded(route.distanceKm - position, consumption);
      if (fuel >= fuelToEnd) {
        return { stops, isFeasible: true };
      }

      const reachable = stations.filter(
        (station) =>
          !stops.some((stop) => stop.id === station.id) &&
          station.kmFromStart >= position &&
          calc().calculateFuelNeeded(station.kmFromStart - position + station.offRouteKm, consumption) <= fuel,
      );
      if (!reachable.length) {
        return { stops, isFeasible: false };
      }

      const { station, fuelOnArrival } = pickNextStop(reachable, strategy, fuel, position, route, vehicle);
      const liters = calculatePurchaseLiters(
        fuelOnArrival,
        getFuelToFinish(route, station, consumption),
        tankCapacity,
      );

      stops.push({
        ...station,
        fuelOnArrival,
        liters,
        cost: calc().calculateFuelCost(liters, station.pricePerLiter),
        fuelAfterRefuel: fuelOnArrival + liters,
      });

      fuel =
        fuelOnArrival + liters - calc().calculateFuelNeeded(station.offRouteKm, consumption);
      position = station.kmFromStart;
    }

    return { stops, isFeasible: false };
  }

  // Цена литра для формулы стоимости. Если заправка в пути есть — это её цена
  // (при нескольких остановках — средневзвешенная). Если нет — средняя цена по маршруту.
  function getEffectivePrice(stops, stations, fallbackPrice) {
    const boughtLiters = stops.reduce((sum, stop) => sum + stop.liters, 0);
    if (boughtLiters > 0) {
      return stops.reduce((sum, stop) => sum + stop.cost, 0) / boughtLiters;
    }
    if (stations.length) {
      return stations.reduce((sum, station) => sum + station.pricePerLiter, 0) / stations.length;
    }
    return fallbackPrice;
  }

  function buildCandidate(route, stations, plan, vehicle, fallbackPrice) {
    const { stops, isFeasible } = plan;
    const detourKm = stops.reduce((sum, stop) => sum + stop.detourKm, 0);
    const distanceKm = route.distanceKm + detourKm;
    const extraMinutes = stops.reduce((sum, stop) => sum + stop.extraMinutes, 0);
    const boughtFuel = stops.reduce((sum, stop) => sum + stop.liters, 0);
    const fuelNeeded = calc().calculateFuelNeeded(distanceKm, vehicle.consumption);
    const pricePerLiter = getEffectivePrice(stops, stations, fallbackPrice);

    return {
      route,
      stops,
      isFeasible,
      distanceKm,
      drivingMinutes: route.durationMinutes,
      extraMinutes,
      totalMinutes: route.durationMinutes + extraMinutes,
      fuelNeeded,
      boughtFuel,
      pricePerLiter,
      fuelCost: pricePerLiter === null ? null : calc().calculateFuelCost(fuelNeeded, pricePerLiter),
      paymentOnRoute: stops.reduce((sum, stop) => sum + stop.cost, 0),
      remainingFuel: calc().calculateRemainingFuel(vehicle.currentFuel, boughtFuel, fuelNeeded),
      hasStationsOnRoute: stations.length > 0,
      isPriceEstimated: stops.length === 0,
    };
  }

  // Балансирует время с ценой, когда она известна, иначе — с длиной маршрута.
  function addBalancedScores(candidates, useCost) {
    const primaryValues = candidates.map((candidate) => useCost ? candidate.fuelCost : candidate.distanceKm);
    const times = candidates.map((candidate) => candidate.totalMinutes);
    const [minPrimary, maxPrimary] = [Math.min(...primaryValues), Math.max(...primaryValues)];
    const [minTime, maxTime] = [Math.min(...times), Math.max(...times)];

    return candidates.map((candidate) => ({
      ...candidate,
      balanceScore:
        OPTIMIZATION_WEIGHTS.cost * calc().normalize(useCost ? candidate.fuelCost : candidate.distanceKm, minPrimary, maxPrimary) +
        OPTIMIZATION_WEIGHTS.time * calc().normalize(candidate.totalMinutes, minTime, maxTime),
    }));
  }

  function getCandidateKey(candidate) {
    return [candidate.route.id, ...candidate.stops.map((stop) => stop.id)].join("|");
  }

  function pickBest(candidates, compare) {
    return [...candidates].sort(compare)[0];
  }

  // Строит варианты по реальным маршрутам; резервная цена задаётся пользователем.
  async function buildTripVariants(routes, vehicle, fallbackPrice = null) {
    if (!Number.isFinite(fallbackPrice) || fallbackPrice <= 0) fallbackPrice = null;
    const candidatesByKey = new Map();

    for (const route of routes) {
      const stations = await getUsableStations(route, vehicle.fuelType);

      for (const strategy of Object.keys(STOP_COMPARATORS)) {
        const plan = buildRefuelPlan(route, stations, vehicle, strategy);
        const candidate = buildCandidate(route, stations, plan, vehicle, fallbackPrice);
        candidatesByKey.set(getCandidateKey(candidate), candidate);
      }
    }

    // Вариант, с которым нельзя доехать, выбираем только если других нет.
    const allCandidates = [...candidatesByKey.values()];
    const feasible = allCandidates.filter((candidate) => candidate.isFeasible);
    const candidates = feasible.length ? feasible : allCandidates;
    // Стоимость можно сравнивать, только если она рассчитана для каждого варианта.
    const hasComparableCosts = candidates.length > 0 && candidates.every((candidate) => Number.isFinite(candidate.fuelCost));
    const pool = addBalancedScores(candidates, hasComparableCosts);

    const primaryCompare = hasComparableCosts
      ? (a, b) => a.fuelCost - b.fuelCost || a.totalMinutes - b.totalMinutes
      : (a, b) => a.distanceKm - b.distanceKm || a.totalMinutes - b.totalMinutes;
    const winners = new Map([
      ["cheapest", pickBest(pool, primaryCompare)],
      ["fastest", pickBest(pool, (a, b) => a.totalMinutes - b.totalMinutes || a.distanceKm - b.distanceKm)],
      ["balanced", pickBest(pool, (a, b) => a.balanceScore - b.balanceScore)],
    ]);
    const labels = {
      ...VARIANT_LABELS,
      ...(hasComparableCosts ? {} : { cheapest: VARIANT_LABELS.shortest, balanced: VARIANT_LABELS.distanceBalanced }),
    };
    const descriptions = {
      ...VARIANT_DESCRIPTIONS,
      ...(hasComparableCosts ? {} : { cheapest: VARIANT_DESCRIPTIONS.shortest, balanced: VARIANT_DESCRIPTIONS.distanceBalanced }),
    };

    return [...winners.entries()].map(([key, candidate]) => ({
      ...candidate,
      key,
      label: labels[key],
      description: descriptions[key],
      sameAs: [...winners.entries()]
        .filter(([otherKey, other]) => otherKey !== key && other === candidate)
        .map(([otherKey]) => labels[otherKey]),
      comparisonBasis: hasComparableCosts ? "cost-time" : "distance-time",
    }));
  }

  // Предупреждения по выбранному варианту. Цвет задаётся полем type.
  function buildTripWarnings(variant, vehicle) {
    const warnings = [];
    const reserve = calc().calculateReserveLiters(vehicle.tankCapacity);
    const [firstStop] = variant.stops;

    if (variant.fuelCost === null) {
      warnings.push({
        type: "info",
        text: "Цены топлива неизвестны: варианты сравнивают длину маршрута и время. Введите цену, чтобы сравнить стоимость.",
      });
    }

    if (!variant.hasStationsOnRoute) {
      warnings.push({
        type: variant.isFeasible ? "info" : "danger",
        text: "На маршруте не найдено подходящих заправок с выбранным типом топлива",
      });
    }

    if (!variant.isFeasible) {
      warnings.push({ type: "danger", text: "Топлива может не хватить до ближайшей заправки" });
    } else if (firstStop) {
      warnings.push({
        type: "danger",
        text: "Топлива в баке не хватит на всю поездку: нужна дозаправка в пути",
      });
      if (firstStop.fuelOnArrival < reserve) {
        warnings.push({
          type: "warning",
          text: "До первой заправки топлива хватает, но запас небольшой",
        });
      }
      warnings.push({
        type: "info",
        text: `Первая остановка: ${firstStop.name}, ${Math.round(firstStop.kmFromStart)} км от старта`,
      });
    } else if (variant.remainingFuel < reserve) {
      warnings.push({
        type: "warning",
        text: "Топлива должно хватить на всю поездку, но запас небольшой",
      });
    } else {
      warnings.push({ type: "success", text: "Топлива должно хватить на всю поездку" });
    }

    return warnings;
  }

  ns.optimizer = {
    OPTIMIZATION_WEIGHTS,
    MAX_DETOUR_KM,
    getRecommendedStations,
    buildTripVariants,
    buildTripWarnings,
  };
})();
