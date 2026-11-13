// Работа с DOM: чтение формы и отрисовка. Бизнес-логики здесь нет.
// Текст вставляется только через textContent, поэтому введённые строки не исполняются как HTML.
(() => {
  const ns = (globalThis.FuelWise ??= {});

  const PRICE_UNIT = "₽";
  const LOCALE = "ru";

  const byId = (id) => document.getElementById(id);

  const FIELD_IDS = {
    startPoint: "start-point",
    endPoint: "end-point",
    consumption: "consumption",
    currentFuel: "current-fuel",
    tankCapacity: "tank-capacity",
    fuelType: "fuel-type",
    pricePerLiter: "price-per-liter",
  };

  // Создание элемента: el("p", { className: "x" }, "текст", дочерний элемент)
  function el(tag, properties = {}, ...children) {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(properties)) {
      if (name.startsWith("aria-") || name === "role") {
        element.setAttribute(name, value);
      } else {
        element[name] = value;
      }
    }
    element.append(...children.filter((child) => child !== null));
    return element;
  }

  function formatNumber(value, maxDigits = 1) {
    return value.toLocaleString(LOCALE, { maximumFractionDigits: maxDigits });
  }

  function formatLiters(value) {
    return `${formatNumber(value, 1)}\u00a0л`;
  }

  function formatKm(value) {
    return `${formatNumber(value, 1)}\u00a0км`;
  }

  function formatPrice(value) {
    return value === null
      ? "нет данных"
      : `${value.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\u00a0${PRICE_UNIT}`;
  }

  function formatMoney(value) {
    return value === null ? "нет данных" : `${formatNumber(value, 0)}\u00a0${PRICE_UNIT}`;
  }

  function formatDuration(totalMinutes) {
    const rounded = Math.round(totalMinutes);
    const hours = Math.floor(rounded / 60);
    const minutes = rounded % 60;
    if (!hours) {
      return `${minutes} мин`;
    }
    return minutes ? `${hours} ч ${minutes} мин` : `${hours} ч`;
  }

  function formatDateTime(isoDate) {
    return new Date(isoDate).toLocaleString(LOCALE, { dateStyle: "short", timeStyle: "short" });
  }

  function replaceOptions(select, options, placeholder) {
    const items = options.map(({ value, label }) => el("option", { value }, label));
    const first = placeholder ? [el("option", { value: "" }, placeholder)] : [];
    select.replaceChildren(...first, ...items);
  }

  function renderLocationChoices(target, locations, onSelect, message = "") {
    const container = byId(`${target}-point-choices`);
    if (!container) return;

    if (message) {
      container.replaceChildren(el("p", { className: "field__hint" }, message));
      return;
    }

    container.replaceChildren(
      ...locations.map((location) => {
        const option = el("button", {
          type: "button",
          className: "location-choice",
          role: "option",
          onclick: () => onSelect(location),
        },
        el("span", { className: "location-choice__title" }, location.name),
        el("span", { className: "location-choice__detail" }, [
          location.addressDetail,
          location.objectType,
          location.matchHint,
        ].filter(Boolean).join(" · ")),
        );
        return option;
      }),
    );
  }

  function clearLocationChoices(target) {
    byId(`${target}-point-choices`)?.replaceChildren();
  }

  function populateFuelTypes(fuelTypes) {
    replaceOptions(
      byId("fuel-type"),
      fuelTypes.map((type) => ({ value: type, label: type })),
    );
  }

  function getTripInput() {
    return {
      startPoint: byId("start-point").value,
      endPoint: byId("end-point").value,
      consumption: byId("consumption").value,
      currentFuel: byId("current-fuel").value,
      tankCapacity: byId("tank-capacity").value,
      fuelType: byId("fuel-type").value,
      pricePerLiter: byId("price-per-liter").value,
      priority: document.querySelector('input[name="priority"]:checked').value,
    };
  }

  function setVehicleInput({ consumption, currentFuel, tankCapacity, fuelType, pricePerLiter }) {
    byId("consumption").value = consumption ?? "";
    byId("current-fuel").value = currentFuel ?? "";
    byId("tank-capacity").value = tankCapacity ?? "";
    byId("price-per-liter").value = pricePerLiter ?? "";
    if ([...byId("fuel-type").options].some((option) => option.value === fuelType)) {
      byId("fuel-type").value = fuelType;
    }
  }

  function setPoints(startName, endName) {
    byId("start-point").value = startName;
    byId("end-point").value = endName;
  }

  function setPriority(priority) {
    const radio = document.querySelector(`input[name="priority"][value="${priority}"]`);
    if (radio) {
      radio.checked = true;
    }
  }

  function clearFieldErrors(root = document) {
    root.querySelectorAll("[data-error-for]").forEach((node) => {
      node.textContent = "";
    });
    root.querySelectorAll('[aria-invalid="true"]').forEach((node) => {
      node.removeAttribute("aria-invalid");
    });
  }

  // Показывает ошибки у полей и переводит фокус на первое неверное поле.
  function showFieldErrors(errors) {
    let firstInvalidField = null;

    for (const [key, message] of Object.entries(errors)) {
      const errorNode = document.querySelector(`[data-error-for="${key}"]`);
      if (errorNode) {
        errorNode.textContent = message;
      }

      const field = byId(FIELD_IDS[key]);
      if (field) {
        field.setAttribute("aria-invalid", "true");
        firstInvalidField ??= field;
      }
    }

    firstInvalidField?.focus();
  }

  function renderWarnings(warnings) {
    byId("warnings").replaceChildren(
      ...warnings.map(({ type, text }) => el("div", { className: `notice notice--${type}` }, text)),
    );
  }

  function setCalculating(isCalculating) {
    byId("calculate").disabled = isCalculating;
  }

  function setOffline(isOffline) {
    byId("offline-banner").hidden = !isOffline;
  }

  function showAppError(message) {
    const node = byId("app-error");
    node.textContent = message;
    node.hidden = !message;
  }

  function setMapStatus(message) {
    const node = byId("map-status");
    node.textContent = message;
    node.hidden = !message;
  }

  function setPickButtons(target) {
    byId("pick-start").setAttribute("aria-pressed", String(target === "start"));
    byId("pick-end").setAttribute("aria-pressed", String(target === "end"));
  }

  function setVehicleStatus(message) {
    byId("vehicle-status").textContent = message;
  }

  function setThemeButton(isDark) {
    byId("theme-toggle").textContent = isDark ? "Светлая тема" : "Тёмная тема";
  }

  function createStat(label, value, note) {
    return el(
      "div",
      { className: "stat" },
      el("span", { className: "stat__label" }, label),
      el("span", { className: "stat__value" }, value),
      note ? el("span", { className: "stat__note" }, note) : null,
    );
  }

  function formatRemainingFuel(liters) {
    return liters < 0 ? `нехватка ${formatLiters(-liters)}` : formatLiters(liters);
  }

  function renderSummary(variant) {
    const stopsNote = variant.extraMinutes
      ? `вождение ${formatDuration(variant.drivingMinutes)}, заправки ${formatDuration(variant.extraMinutes)}`
      : null;
    const detourKm = variant.distanceKm - variant.route.distanceKm;
    const priceNote = variant.isPriceEstimated
      ? "средняя цена, заправка не требуется"
      : "цена на заправках плана";

    byId("trip-summary").replaceChildren(
      el("p", { className: "summary-title" }, variant.route.name),
      el(
        "div",
        { className: "stat-grid" },
        createStat("Расстояние", formatKm(variant.distanceKm), detourKm > 0 ? `из них съезды ${formatKm(detourKm)}` : null),
        createStat("Время в пути", formatDuration(variant.totalMinutes), stopsNote),
        createStat("Необходимое топливо", formatLiters(variant.fuelNeeded)),
        createStat("Остаток после поездки", formatRemainingFuel(variant.remainingFuel)),
        createStat("Стоимость топлива", formatMoney(variant.fuelCost), "топливо на всю поездку"),
        createStat("Цена за литр", formatPrice(variant.pricePerLiter), priceNote),
        createStat("Купить в пути", formatLiters(variant.boughtFuel), `заправок: ${variant.stops.length}`),
        createStat("К оплате в пути", formatMoney(variant.paymentOnRoute)),
      ),
    );
  }

  function renderVariantCards(variants, selectedKey, onSelect) {
    byId("variant-cards").replaceChildren(
      ...variants.map((variant) =>
        el(
          "button",
          {
            type: "button",
            className: "variant-card",
            "aria-pressed": String(variant.key === selectedKey),
            onclick: () => onSelect(variant.key),
          },
          el("span", { className: "variant-card__title" }, variant.label),
          el("span", { className: "variant-card__text" }, variant.description),
          el(
            "span",
            { className: "variant-card__metrics" },
            `${formatMoney(variant.fuelCost)} · ${formatDuration(variant.totalMinutes)}`,
          ),
          el("span", { className: "variant-card__text" }, variant.route.name),
          variant.sameAs.length
            ? el("span", { className: "variant-card__text" }, `Совпадает с: ${variant.sameAs.join(", ")}`)
            : null,
        ),
      ),
    );
  }

  function renderComparison(variants, selectedKey) {
    byId("comparison-body").replaceChildren(
      ...variants.map((variant) =>
        el(
          "tr",
          { className: variant.key === selectedKey ? "is-selected" : "" },
          el("th", { scope: "row" }, variant.label),
          el("td", {}, formatKm(variant.distanceKm)),
          el("td", {}, formatDuration(variant.totalMinutes)),
          el("td", {}, formatLiters(variant.fuelNeeded)),
          el("td", {}, formatMoney(variant.fuelCost)),
          el("td", {}, String(variant.stops.length)),
          el("td", {}, variant.extraMinutes ? formatDuration(variant.extraMinutes) : "—"),
          el("td", {}, formatRemainingFuel(variant.remainingFuel)),
        ),
      ),
    );
  }

  function createBarChart(title, variants, getValue, formatValue) {
    const values = variants.map((variant) => getValue(variant));
    const numericValues = values.filter((value) => Number.isFinite(value));
    const maxValue = numericValues.length ? Math.max(...numericValues) : 0;

    return el(
      "div",
      { className: "chart" },
      el("p", { className: "chart__title" }, title),
      ...variants.map((variant, index) => {
        const value = values[index];
        const hasValue = Number.isFinite(value);
        const widthPercent = hasValue && maxValue > 0 ? (value / maxValue) * 100 : 0;
        const bar = el("div", { className: "chart__bar" });
        bar.style.width = `${widthPercent}%`;

        return el(
          "div",
          { className: "chart__row", title: `${variant.label}: ${hasValue ? formatValue(value) : "нет данных"}` },
          el("span", {}, variant.label),
          el("div", { className: "chart__track" }, bar),
          el("span", {}, hasValue ? formatValue(value) : "нет данных"),
        );
      }),
    );
  }

  function renderCharts(variants) {
    byId("charts").replaceChildren(
      createBarChart("Стоимость топлива", variants, (variant) => variant.fuelCost, formatMoney),
      createBarChart("Время в пути", variants, (variant) => variant.totalMinutes, formatDuration),
    );
  }

  function renderStopPlan(variant) {
    if (!variant.stops.length) {
      byId("stop-plan").replaceChildren();
      return;
    }

    byId("stop-plan").replaceChildren(
      el("h3", {}, "План заправок"),
      el(
        "ol",
        { className: "stop-plan" },
        ...variant.stops.map((stop) =>
          el(
            "li",
            {},
            `${formatNumber(stop.kmFromStart, 0)} км от старта: ${stop.name}. ` +
              `В баке при подъезде ${formatLiters(stop.fuelOnArrival)}, купить ${formatLiters(stop.liters)} ` +
              `за ${formatMoney(stop.cost)}, в баке после заправки ${formatLiters(stop.fuelAfterRefuel)}, ` +
              `дополнительное время ${formatDuration(stop.extraMinutes)}.`,
          ),
        ),
      ),
    );
  }

  function createTag(text, type) {
    return el("span", { className: `tag notice--${type}` }, text);
  }

  // Для заправки из плана показываем данные плана: они учитывают предыдущие остановки.
  // Для остальных расчёт идёт от топлива, которое есть в баке на старте.
  function createStationCard(station, stop) {
    const liters = stop?.liters ?? station.litersToBuy;
    const cost = stop?.cost ?? station.refuelCost;

    const tags = [
      stop ? createTag("В плане поездки", "success") : null,
      !stop && !station.isReachable ? createTag("Топлива может не хватить", "danger") : null,
      !stop && !station.coversTrip ? createTag("Понадобится ещё заправка", "warning") : null,
      station.isOpen24h ? createTag("Круглосуточно", "demo") : null,
    ].filter(Boolean);

    const facts = [
      ["От маршрута", formatKm(station.offRouteKm)],
      ["От старта", `${formatNumber(station.kmFromStart, 0)} км`],
      ["Доп. время", formatDuration(station.extraMinutes)],
      ["Наличие топлива", station.fuel.available ? "есть" : "нет"],
      ["Купить", liters > 0 ? formatLiters(liters) : "не требуется"],
      ["Стоимость заправки", liters > 0 ? formatMoney(cost) : "—"],
    ];

    return el(
      "article",
      { className: "station-card" },
      el(
        "div",
        { className: "station-card__head" },
        el(
          "div",
          {},
          el("h3", {}, station.name),
          el("p", { className: "station-card__brand" }, station.brand),
        ),
        el("span", { className: "station-card__price" }, formatPrice(station.pricePerLiter)),
      ),
      el(
        "dl",
        { className: "station-card__facts" },
        ...facts.flatMap(([term, value]) => [el("dt", {}, term), el("dd", {}, value)]),
      ),
      tags.length ? el("div", { className: "tags" }, ...tags) : null,
    );
  }

  function renderStations(stations, stops) {
    const container = byId("station-cards");
    if (!stations.length) {
      container.replaceChildren(el("p", { className: "field__hint" }, "Подходящих заправок на этом маршруте нет."));
      return;
    }
    container.replaceChildren(
      ...stations.map((station) => createStationCard(station, stops.find(({ id }) => id === station.id))),
    );
  }

  function renderResults({ variants, selectedKey, stations, onSelectVariant }) {
    const variant = variants.find(({ key }) => key === selectedKey);

    renderSummary(variant);
    renderVariantCards(variants, selectedKey, onSelectVariant);
    renderComparison(variants, selectedKey);
    renderCharts(variants);
    renderStopPlan(variant);
    renderStations(stations, variant.stops);
    byId("results").hidden = false;
  }

  // На телефоне карта и результаты находятся ниже формы, поэтому к ним нужно прокрутить.
  function revealMap() {
    document.querySelector(".card--map").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function hideResults() {
    byId("results").hidden = true;
  }

  function renderHistory(history, { onRepeat, onDelete }) {
    byId("history-empty").hidden = history.length > 0;
    byId("export-history").disabled = history.length === 0;
    byId("clear-history").disabled = history.length === 0;

    byId("history-list").replaceChildren(
      ...history.map((entry) => {
        const canRepeat = Boolean(entry.startLocation && entry.endLocation && entry.route?.geometry?.length >= 2);
        return el(
          "li",
          { className: "history-item" },
          el(
            "div",
            {},
            el("p", { className: "history-item__title" }, `${entry.startName} — ${entry.endName}`),
            el(
              "p",
              { className: "history-item__meta" },
              `${formatDateTime(entry.createdAt)} · ${formatKm(entry.distanceKm)} · ` +
                `${formatNumber(entry.consumption, 1)} л/100 км · ${entry.fuelType} · ` +
                `${formatMoney(entry.fuelCost)} · ${entry.variantLabel}`,
            ),
          ),
          el(
            "div",
            { className: "history-item__actions" },
            el("button", {
              type: "button",
              className: "button button--ghost button--small",
              disabled: !canRepeat,
              title: canRepeat ? "Повторить сохранённый маршрут" : "В этой старой записи нет координат маршрута",
              onclick: () => onRepeat(entry),
            }, "Повторить"),
            el("button", { type: "button", className: "button button--ghost button--small", onclick: () => onDelete(entry.id) }, "Удалить"),
          ),
        );
      }),
    );
  }

  // Значения, начинающиеся с =, +, - или @, таблицы считают формулами.
  function escapeCsvValue(value) {
    const text = String(value ?? "");
    const safeText = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safeText.replaceAll('"', '""')}"`;
  }

  function downloadHistoryCsv(history) {
    const header = ["Дата и время", "Точка А", "Точка Б", "Расстояние, км", "Расход, л/100 км", "Тип топлива", "Стоимость, ₽", "Вариант"];
    const rows = history.map((entry) => [
      formatDateTime(entry.createdAt),
      entry.startName,
      entry.endName,
      formatNumber(entry.distanceKm, 1),
      formatNumber(entry.consumption, 1),
      entry.fuelType,
      entry.fuelCost === null ? "" : formatNumber(entry.fuelCost, 2),
      entry.variantLabel,
    ]);

    const csv = [header, ...rows].map((row) => row.map(escapeCsvValue).join(";")).join("\r\n");
    // BOM нужен, чтобы табличные редакторы верно определили кодировку.
    const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = el("a", { href: url, download: "fuelwise-history.csv" });
    link.click();
    URL.revokeObjectURL(url);
  }

  // Подключает обработчики к постоянным элементам страницы.
  function bindEvents(handlers) {
    byId("trip-form").addEventListener("submit", (event) => {
      event.preventDefault();
      handlers.onCalculate();
    });
    byId("start-point").addEventListener("input", () => handlers.onPointTextChanged("start"));
    byId("end-point").addEventListener("input", () => handlers.onPointTextChanged("end"));
    byId("search-start").addEventListener("click", () => handlers.onLocationSearch("start"));
    byId("search-end").addEventListener("click", () => handlers.onLocationSearch("end"));
    byId("swap-points").addEventListener("click", handlers.onSwapPoints);
    byId("pick-start").addEventListener("click", () => handlers.onPickToggle("start"));
    byId("pick-end").addEventListener("click", () => handlers.onPickToggle("end"));
    byId("save-vehicle").addEventListener("click", handlers.onSaveVehicle);
    byId("reset").addEventListener("click", handlers.onReset);
    byId("theme-toggle").addEventListener("click", handlers.onThemeToggle);
    byId("export-history").addEventListener("click", handlers.onExportHistory);
    byId("clear-history").addEventListener("click", handlers.onClearHistory);
  }

  ns.ui = {
    formatNumber,
    formatPrice,
    bindEvents,
    renderLocationChoices,
    clearLocationChoices,
    populateFuelTypes,
    getTripInput,
    setVehicleInput,
    setPoints,
    setPriority,
    clearFieldErrors,
    showFieldErrors,
    renderWarnings,
    setCalculating,
    setOffline,
    showAppError,
    setMapStatus,
    setPickButtons,
    setVehicleStatus,
    setThemeButton,
    renderResults,
    revealMap,
    hideResults,
    renderHistory,
    downloadHistoryCsv,
  };
})();
