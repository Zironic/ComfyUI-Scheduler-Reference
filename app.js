(() => {
  "use strict";

  const data = window.SCHEDULER_DATA;
  if (!data) {
    document.body.innerHTML = "<p>Generated scheduler data is missing. Run generate.py.</p>";
    return;
  }

  const state = {
    regime: data.defaults.regime,
    metric: data.defaults.metric === "sigma" ? "sigma" : "drops",
    scale: "linear",
    steps: data.defaults.steps,
    hidden: new Set(),
    cursor: null,
  };

  const order = data.scheduler_order;
  const $ = (selector) => document.querySelector(selector);
  const compact = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 5 });
  const logLinearThreshold = 1e-3;

  function sourceRoot() {
    return `${data.generated_from.repository}/tree/${data.generated_from.commit}`;
  }

  function parseHash() {
    const match = location.hash.match(/^#view=([^&]+)&metric=(sigma|drops)&scale=(linear|log)&steps=(\d+)$/);
    if (!match || !data.regimes[match[1]]) return;
    state.regime = match[1];
    state.metric = match[2];
    state.scale = state.metric === "sigma" ? match[3] : "linear";
    state.steps = Math.min(data.step_range.max, Math.max(data.step_range.min, Number(match[4])));
  }

  function updateHash() {
    history.replaceState(null, "", `#view=${state.regime}&metric=${state.metric}&scale=${state.scale}&steps=${state.steps}`);
  }

  function currentSchedules() {
    return data.regimes[state.regime].schedules[String(state.steps)];
  }

  function seriesFor(name) {
    return currentSchedules()[name][state.metric];
  }

  function formatValue(value) {
    if (value === undefined) return "—";
    if (value !== 0 && Math.abs(value) < 0.0001) return value.toExponential(3);
    return compact.format(value);
  }

  function makeSvg(names, mini = false) {
    const width = mini ? 520 : 1100;
    const height = mini ? 245 : 500;
    const margin = mini ? { left: 42, right: 18, top: 20, bottom: 34 } : { left: 72, right: 28, top: 26, bottom: 58 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const visible = names.filter((name) => !state.hidden.has(name));
    const logScale = state.metric === "sigma" && state.scale === "log";
    const allValues = visible.flatMap((name) => seriesFor(name));
    let yMin = Math.min(0, ...allValues);
    let yMax = Math.max(...allValues);
    if (yMax === yMin) yMax = yMin + 1;
    if (!logScale) {
      const pad = (yMax - yMin) * 0.04;
      yMax += pad;
      if (yMin < 0) yMin -= pad;
    }
    const xMax = Math.max(1, ...visible.map((name) => seriesFor(name).length - 1));
    const x = (value) => margin.left + (value / xMax) * innerWidth;
    const symlog = (value) => value <= logLinearThreshold ? value / logLinearThreshold : 1 + Math.log10(value / logLinearThreshold);
    const inverseSymlog = (value) => value <= 1 ? value * logLinearThreshold : logLinearThreshold * 10 ** (value - 1);
    const symlogMax = symlog(yMax);
    const y = (value) => {
      const ratio = logScale ? symlog(value) / symlogMax : (value - yMin) / (yMax - yMin);
      return margin.top + (1 - ratio) * innerHeight;
    };
    const axisColor = "#80939f";
    const gridColor = "#cbd5dc";
    const textColor = "#61717d";
    const grid = [];
    const labels = [];

    for (let tick = 0; tick <= 5; tick += 1) {
      const value = logScale ? inverseSymlog((symlogMax * tick) / 5) : yMin + ((yMax - yMin) * tick) / 5;
      const py = y(value);
      grid.push(`<line x1="${margin.left}" y1="${py}" x2="${width - margin.right}" y2="${py}" stroke="${gridColor}" stroke-width="1"/>`);
      if (!mini) labels.push(`<text x="${margin.left - 12}" y="${py + 4}" text-anchor="end" fill="${textColor}" font-size="12" font-family="Cascadia Mono,monospace">${formatValue(value)}</text>`);
    }
    for (let tick = 0; tick <= 5; tick += 1) {
      const value = Math.round((xMax * tick) / 5);
      const px = x(value);
      grid.push(`<line x1="${px}" y1="${margin.top}" x2="${px}" y2="${height - margin.bottom}" stroke="${gridColor}" stroke-width="1"/>`);
      labels.push(`<text x="${px}" y="${height - margin.bottom + (mini ? 20 : 25)}" text-anchor="middle" fill="${textColor}" font-size="${mini ? 11 : 12}" font-family="Cascadia Mono,monospace">${value}</text>`);
    }

    const paths = visible.map((name) => {
      const values = seriesFor(name);
      const path = values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
      return `<path d="${path}" fill="none" stroke="${data.schedulers[name].color}" stroke-width="${mini ? 3 : 2.6}" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"><title>${name}</title></path>`;
    }).join("");
    const terminalMarkers = state.metric === "sigma" ? [...new Set(visible.map((name) => seriesFor(name).length - 1))].map((index) => {
      const px = x(index);
      const py = y(0);
      const radius = mini ? 5 : 6;
      return `<g stroke="#d23b3b" stroke-width="2.2" pointer-events="none"><line x1="${px - radius}" y1="${py - radius}" x2="${px + radius}" y2="${py + radius}"/><line x1="${px + radius}" y1="${py - radius}" x2="${px - radius}" y2="${py + radius}"/></g>`;
    }).join("") : "";
    const logNote = logScale && !mini ? `<text x="${width - margin.right}" y="${height - margin.bottom - 10}" text-anchor="end" fill="#d23b3b" font-size="11" font-family="Cascadia Mono,monospace">symlog linear zone 0…1e-3 includes terminal σ=0</text>` : "";

    const cursorIndex = state.cursor === null ? Math.round(xMax / 2) : Math.min(xMax, state.cursor);
    const cursor = mini ? "" : `<g class="plot-cursor" pointer-events="none"><line x1="${x(cursorIndex)}" y1="${margin.top}" x2="${x(cursorIndex)}" y2="${height - margin.bottom}" stroke="#d23b3b" stroke-width="1.5" stroke-dasharray="4 4"/><circle cx="${x(cursorIndex)}" cy="${margin.top}" r="5" fill="#d23b3b"/></g>`;
    const axisLabel = mini ? "" : `<text x="${margin.left + innerWidth / 2}" y="${height - 10}" text-anchor="middle" fill="${textColor}" font-size="12" font-family="Cascadia Mono,monospace">Schedule interval / nominal evaluation</text><text transform="translate(18 ${margin.top + innerHeight / 2}) rotate(-90)" text-anchor="middle" fill="${textColor}" font-size="12" font-family="Cascadia Mono,monospace">${state.metric === "sigma" ? `Sigma${logScale ? " (symlog + zero)" : ""}` : "Sigma drop"}</text>`;
    return {
      markup: `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${state.metric === "sigma" ? `${state.scale === "log" ? "symmetric-log" : "linear"} sigma` : "Sigma drop"} chart"><rect width="${width}" height="${height}" fill="#f4f7f8"/>${grid.join("")}${labels.join("")}<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="${axisColor}"/>${paths}${terminalMarkers}${cursor}${axisLabel}${logNote}<rect class="plot-hit" x="${margin.left}" y="${margin.top}" width="${innerWidth}" height="${innerHeight}" fill="transparent" tabindex="0"/></svg>`,
      geometry: { width, margin, innerWidth, xMax },
      cursorIndex,
    };
  }

  function renderReadout(index) {
    const rows = order.filter((name) => !state.hidden.has(name)).map((name) => {
      const values = seriesFor(name);
      return `<div class="readout-row"><i style="background:${data.schedulers[name].color}"></i><strong>${name}</strong><span>${formatValue(values[index])}</span></div>`;
    }).join("");
    $("#plot-readout").innerHTML = `<div class="readout-head"><span>Interval ${index}</span><span>${state.metric === "sigma" ? "σ" : "σᵢ−σᵢ₊₁"}</span></div>${rows}`;
  }

  function renderOverlay() {
    const chart = makeSvg(order);
    const host = $("#overlay-plot");
    host.innerHTML = chart.markup;
    renderReadout(chart.cursorIndex);
    const svg = host.querySelector("svg");
    const hit = host.querySelector(".plot-hit");

    const setCursor = (clientX) => {
      const rect = svg.getBoundingClientRect();
      const relative = ((clientX - rect.left) / rect.width) * chart.geometry.width;
      const plotX = Math.min(chart.geometry.innerWidth, Math.max(0, relative - chart.geometry.margin.left));
      state.cursor = Math.round((plotX / chart.geometry.innerWidth) * chart.geometry.xMax);
      renderPlotsOnly();
    };
    hit.addEventListener("pointermove", (event) => setCursor(event.clientX));
    hit.addEventListener("pointerdown", (event) => setCursor(event.clientX));
    hit.addEventListener("keydown", (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      state.cursor = Math.min(chart.geometry.xMax, Math.max(0, chart.cursorIndex + (event.key === 'ArrowRight' ? 1 : -1)));
      renderPlotsOnly();
      $("#overlay-plot .plot-hit").focus();
    });
  }

  function renderTabs() {
    $("#regime-tabs").innerHTML = Object.entries(data.regimes).map(([key, regime]) => `<button type="button" role="tab" aria-selected="${key === state.regime}" data-regime="${key}">${regime.short_name}</button>`).join("");
    $("#regime-tabs").querySelectorAll("button").forEach((button) => button.addEventListener("click", () => {
      state.regime = button.dataset.regime;
      state.cursor = null;
      render();
    }));
  }

  function renderLegend() {
    $("#legend").innerHTML = order.map((name) => `<button type="button" aria-pressed="${!state.hidden.has(name)}" data-scheduler="${name}"><i class="legend-swatch" style="background:${data.schedulers[name].color}"></i>${name}</button>`).join("");
    $("#legend").querySelectorAll("button").forEach((button) => button.addEventListener("click", () => {
      const name = button.dataset.scheduler;
      if (state.hidden.has(name)) state.hidden.delete(name);
      else if (state.hidden.size < order.length - 1) state.hidden.add(name);
      renderPlotsOnly();
      renderLegend();
    }));
  }

  function assetPath(name, extension) {
    const metric = state.metric === "sigma" ? (state.scale === "log" ? "sigma-log" : "sigma") : "delta-sigma";
    return `assets/${state.regime}/${name}-${metric}.${extension}`;
  }

  function renderCards() {
    const schedules = currentSchedules();
    $("#scheduler-cards").innerHTML = order.map((name, index) => {
      const scheduler = data.schedulers[name];
      const chart = makeSvg([name], true).markup;
      const count = schedules[name].evaluations;
      const sigmas = schedules[name].sigmas;
      const lastFinite = sigmas[sigmas.length - 2];
      return `<article class="scheduler-card" id="scheduler-${name}">
        <div class="card-head"><i class="legend-swatch" style="background:${scheduler.color}"></i><span class="card-index">${String(index + 1).padStart(2, "0")} / ${String(order.length).padStart(2, "0")}</span></div>
        <h3>${name}</h3>
        <p class="description">${scheduler.description}</p>
        <div class="mini-plot">${chart}</div>
        <div class="card-meta"><span><code>${scheduler.parameters.replace("{steps}", state.steps)}</code></span><span>${data.regimes[state.regime].short_name} · ${count} schedule intervals · last finite σ ${formatValue(lastFinite)}</span><span><code>${data.regimes[state.regime].parameters}</code></span></div>
        <div class="card-links"><a href="${scheduler.source}">Source ↗</a><a href="${assetPath(name, "svg")}">SVG (20)</a><a href="${assetPath(name, "png")}">PNG (20)</a></div>
      </article>`;
    }).join("");
  }

  function renderPlotsOnly() {
    renderOverlay();
    renderCards();
  }

  function render() {
    const regime = data.regimes[state.regime];
    updateHash();
    renderTabs();
    document.querySelectorAll("[data-metric]").forEach((button) => button.setAttribute("aria-pressed", button.dataset.metric === state.metric));
    document.querySelectorAll("[data-scale]").forEach((button) => button.setAttribute("aria-pressed", button.dataset.scale === state.scale));
    $(".scale-control").setAttribute("aria-hidden", state.metric !== "sigma");
    $("#steps").value = state.steps;
    $("#steps-output").value = state.steps;
    $("#regime-note").innerHTML = `<p>${regime.description}</p><p><code>${regime.parameters}</code><br>finite σ range ${formatValue(regime.sigma_min)} → ${formatValue(regime.sigma_max)}</p>`;
    const metricSlug = state.metric === "sigma" ? (state.scale === "log" ? "sigma-log" : "sigma") : "delta-sigma";
    $("#overlay-assets").innerHTML = `<a href="assets/${state.regime}/all-schedulers-${metricSlug}.svg">Download default SVG</a><a href="assets/${state.regime}/all-schedulers-${metricSlug}.png">Download default PNG</a><span>Static assets use steps=${data.defaults.steps}</span>`;
    renderLegend();
    renderPlotsOnly();
  }

  parseHash();
  const commit = data.generated_from.commit;
  $("#scheduler-count").textContent = order.length;
  $("#source-commit").textContent = commit.slice(0, 8);
  $("#source-commit").href = sourceRoot();
  $("#source-repository").href = sourceRoot();
  $("#footer-source").href = sourceRoot();
  document.querySelectorAll("[data-metric]").forEach((button) => button.addEventListener("click", () => {
    state.metric = button.dataset.metric;
    if (state.metric !== "sigma") state.scale = "linear";
    state.cursor = null;
    render();
  }));
  document.querySelectorAll("[data-scale]").forEach((button) => button.addEventListener("click", () => {
    state.scale = button.dataset.scale;
    state.cursor = null;
    render();
  }));
  $("#steps").addEventListener("input", (event) => {
    state.steps = Number(event.target.value);
    state.cursor = null;
    render();
  });
  render();
})();
