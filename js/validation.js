// Проверка пользовательского ввода. Возвращает числа и сообщения об ошибках, DOM не трогает.
(() => {
  const ns = (globalThis.FuelWise ??= {});

  const MAX_REALISTIC_CONSUMPTION = 100; // л/100 км: больше — почти наверняка опечатка

  const INVALID_CONSUMPTION_MESSAGE = "Введён некорректный расход топлива";

  // Принимает и точку, и запятую как десятичный разделитель.
  function parseNumber(rawValue) {
    const text = String(rawValue ?? "").trim().replace(",", ".");
    return text === "" ? NaN : Number(text);
  }

  function validateConsumption(rawValue, consumption) {
    if (String(rawValue ?? "").trim() === "") {
      return "Расход топлива должен быть больше нуля";
    }
    if (!Number.isFinite(consumption) || consumption > MAX_REALISTIC_CONSUMPTION) {
      return INVALID_CONSUMPTION_MESSAGE;
    }
    return consumption > 0 ? null : "Расход топлива должен быть больше нуля";
  }

  function validateCurrentFuel(currentFuel) {
    if (!Number.isFinite(currentFuel)) {
      return "Укажите количество топлива в баке";
    }
    return currentFuel < 0 ? "Количество топлива в баке не может быть отрицательным" : null;
  }

  function validateTankCapacity(tankCapacity) {
    return Number.isFinite(tankCapacity) && tankCapacity > 0
      ? null
      : "Объём бака должен быть больше нуля";
  }

  // Проверяет только параметры автомобиля: их можно сохранить и без выбранного маршрута.
  function validateVehicle(input) {
    const vehicle = {
      consumption: parseNumber(input.consumption),
      currentFuel: parseNumber(input.currentFuel),
      tankCapacity: parseNumber(input.tankCapacity),
      fuelType: input.fuelType,
      pricePerLiter: String(input.pricePerLiter ?? "").trim() === "" ? null : parseNumber(input.pricePerLiter),
    };

    const errors = {
      consumption: validateConsumption(input.consumption, vehicle.consumption),
      currentFuel: validateCurrentFuel(vehicle.currentFuel),
      tankCapacity: validateTankCapacity(vehicle.tankCapacity),
      fuelType: vehicle.fuelType ? null : "Выберите тип топлива",
      pricePerLiter: vehicle.pricePerLiter === null || (Number.isFinite(vehicle.pricePerLiter) && vehicle.pricePerLiter > 0)
        ? null
        : "Цена за литр должна быть числом больше нуля",
    };

    if (!errors.currentFuel && !errors.tankCapacity && vehicle.currentFuel > vehicle.tankCapacity) {
      errors.currentFuel = "Топлива в баке не может быть больше объёма бака";
    }

    return { vehicle, errors: dropEmpty(errors) };
  }

  function validateTrip(input) {
    const { vehicle, errors: vehicleErrors } = validateVehicle(input);

    const routeErrors = {
      startPoint: input.startPoint ? null : "Укажите точку А",
      endPoint: input.endPoint ? null : "Укажите точку Б",
    };
    if (input.startPoint && input.startPoint === input.endPoint) {
      routeErrors.endPoint = "Точка А и точка Б не могут совпадать";
    }

    return { vehicle, errors: { ...dropEmpty(routeErrors), ...vehicleErrors } };
  }

  function dropEmpty(errors) {
    return Object.fromEntries(Object.entries(errors).filter(([, message]) => message));
  }

  ns.validation = { INVALID_CONSUMPTION_MESSAGE, validateVehicle, validateTrip };
})();
