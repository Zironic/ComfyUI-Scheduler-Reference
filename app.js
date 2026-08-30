(() => {
  "use strict";

  const data = window.SCHEDULER_DATA;
  if (!data) {
    document.body.innerHTML = '<main class="error-state"><h1>Scheduler data is missing.</h1><p>Run <code>generate.py</code> and make sure <code>data/schedules.js</code> is deployed beside this page.</p></main>';
    return;
  }

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const order = data.scheduler_order;
  const number = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 5 });
  const LOG_LINTHRESH = 1e-3;

  const COLORS = {
    simple: "#4cc9f0",
    sgm_uniform: "#fb923c",
    karras: "#a78bfa",
    exponential: "#f472b6",
    ddim_uniform: "#4ade80",
    beta: "#facc15",
    normal: "#60a5fa",
    linear_quadratic: "#f87171",
    kl_optimal: "#d6d3d1",
  };

  const state = {
    regime: data.defaults.regime,
    metric: data.defaults.metric === "sigma" ? "sigma" : "drops",
    scale: "linear",
    steps: data.defaults.steps,
    hidden: new Set(),
    cursor: null,
    focus: null,
  };

  let resizeFrame = 0;
  let mainGeometry = null;

  function colorFor(name) {
    return COLORS[name] || data.schedulers[name].color || "#ffffff";
  }

  function formatValue(value) {
    if (value === undefined || value === null || Number.isNaN(value)) return "—";
    if (value === 0) return "0";
    if (Math.abs(value) < 0.0001 || Math.abs(value) >= 10000) return value.toExponential(3);
    return number.format(value);
  }

  function sourceRoot() {
    return `${data.generated_from.repository}/tree/${data.generated_from.commit}`;
  }

  function parseHash() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    const regime = params.get("view");
    const metric = params.get("metric");
    const scale = params.get("scale");
    const steps = Number(params.get("steps"));
    if (regime && data.regimes[regime]) state.regime = regime;
    if (metric === "sigma" || metric === "drops") state.metric = metric;
    if (scale === "linear" || scale === "log") state.scale = scale;
    if (Number.isFinite(steps)) state.steps = Math.min(data.step_range.max, Math.max(data.step_range.min, Math.round(steps)));
    if (state.metric !== "sigma") state.scale = "linear";
  }

  function updateHash() {
    const params = new URLSearchParams({
      view: state.regime,
      metric: state.metric,
      scale: state.scale,
      steps: String(state.steps),
    });
    history.replaceState(null, "", `#${params.toString()}`);
  }

  function currentSchedules() {
    return data.regimes[state.regime].schedules[String(state.steps)];
  }

  function seriesFor(name) {
    return currentSchedules()[name][state.metric];
  }

  function visibleNames() {
    return order.filter((name) => !state.hidden.has(name));
  }

  function symlog(value) {
    if (value <= LOG_LINTHRESH) return value / LOG_LINTHRESH;
    return 1 + Math.log10(value / LOG_LINTHRESH);
  }

  function niceLinearTicks(maxValue, count = 5) {
    if (!(maxValue > 0)) return [0, 1];
    const raw = maxValue / count;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const residual = raw / magnitude;
    const nice = residual >= 5 ? 5 : residual >= 2 ? 2 : 1;
    const step = nice * magnitude;
    const top = Math.ceil(maxValue / step) * step;
    const ticks = [];
    for (let value = 0; value <= top + step * 0.25; value += step) ticks.push(value);
    return ticks;
  }

  function logTicks(maxValue) {
    const ticks = [0, LOG_LINTHRESH];
    for (let value = LOG_LINTHRESH * 10; value <= maxValue * 1.001; value *= 10) ticks.push(value);
    if (maxValue > ticks[ticks.length - 1] * 1.45) ticks.push(maxValue);
    return [...new Set(ticks)].sort((a, b) => a - b);
  }

  function setupCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width, height };
  }

  function drawChart(canvas, names, { mini = false, cursor = null } = {}) {
    const { ctx, width, height } = setupCanvas(canvas);
    const visible = mini ? names : names.filter((name) => !state.hidden.has(name));
    if (!visible.length) return null;

    const margin = mini
      ? { left: 14, right: 12, top: 13, bottom: 18 }
      : { left: width < 640 ? 54 : 66, right: 24, top: 24, bottom: 48 };
    const plot = {
      left: margin.left,
      top: margin.top,
      right: width - margin.right,
      bottom: height - margin.bottom,
    };
    plot.width = Math.max(1, plot.right - plot.left);
    plot.height = Math.max(1, plot.bottom - plot.top);

    const values = visible.flatMap((name) => seriesFor(name));
    const rawMax = Math.max(...values, 0);
    const logScale = state.metric === "sigma" && state.scale === "log";
    const yTicks = logScale ? logTicks(rawMax) : niceLinearTicks(rawMax, mini ? 3 : 5);
    const yMaxRaw = yTicks[yTicks.length - 1] || rawMax || 1;
    const yMax = logScale ? symlog(yMaxRaw) : yMaxRaw;
    const xMax = Math.max(1, ...visible.map((name) => seriesFor(name).length - 1));

    const x = (index) => plot.left + (index / xMax) * plot.width;
    const y = (value) => {
      const transformed = logScale ? symlog(Math.max(0, value)) : value;
      return plot.bottom - (transformed / yMax) * plot.height;
    };

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0d1520";
    ctx.fillRect(0, 0, width, height);

    const bgGradient = ctx.createLinearGradient(0, plot.top, 0, plot.bottom);
    bgGradient.addColorStop(0, "rgba(103,232,249,0.025)");
    bgGradient.addColorStop(1, "rgba(103,232,249,0)");
    ctx.fillStyle = bgGradient;
    ctx.fillRect(plot.left, plot.top, plot.width, plot.height);

    ctx.save();
    ctx.font = `${mini ? 9 : 10}px ${getComputedStyle(document.documentElement).getPropertyValue("--mono")}`;
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "rgba(123, 148, 177, 0.16)";
    ctx.fillStyle = "#74869c";
    ctx.lineWidth = 1;

    for (const tick of yTicks) {
      const py = y(tick);
      ctx.beginPath();
      ctx.moveTo(plot.left, py + 0.5);
      ctx.lineTo(plot.right, py + 0.5);
      ctx.stroke();
      if (!mini) {
        ctx.textAlign = "right";
        ctx.fillText(formatValue(tick), plot.left - 10, py);
      }
    }

    const xTickCount = Math.min(6, xMax);
    for (let i = 0; i <= xTickCount; i += 1) {
      const index = Math.round((xMax * i) / xTickCount);
      const px = x(index);
      ctx.beginPath();
      ctx.moveTo(px + 0.5, plot.top);
      ctx.lineTo(px + 0.5, plot.bottom);
      ctx.stroke();
      if (!mini) {
        ctx.textAlign = "center";
        ctx.fillText(String(index), px, plot.bottom + 18);
      }
    }
    ctx.restore();

    if (!mini) {
      ctx.save();
      ctx.font = `10px ${getComputedStyle(document.documentElement).getPropertyValue("--mono")}`;
      ctx.fillStyle = "#8294aa";
      ctx.textAlign = "center";
      ctx.fillText("schedule interval / nominal evaluation", plot.left + plot.width / 2, height - 13);
      ctx.translate(16, plot.top + plot.height / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(state.metric === "sigma" ? (logScale ? "sigma · symlog + zero" : "sigma") : "sigma drop", 0, 0);
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.left, plot.top, plot.width, plot.height);
    ctx.clip();

    for (const name of visible) {
      const series = seriesFor(name);
      const isFocused = state.focus === null || state.focus === name;
      const alpha = state.focus && state.focus !== name ? 0.16 : 1;
      const color = colorFor(name);

      if (mini && state.metric === "sigma") {
        ctx.beginPath();
        series.forEach((value, index) => {
          const px = x(index);
          const py = y(value);
          if (index === 0) ctx.moveTo(px, plot.bottom);
          ctx.lineTo(px, py);
        });
        ctx.lineTo(x(series.length - 1), plot.bottom);
        ctx.closePath();
        const fill = ctx.createLinearGradient(0, plot.top, 0, plot.bottom);
        fill.addColorStop(0, `${color}22`);
        fill.addColorStop(1, `${color}00`);
        ctx.fillStyle = fill;
        ctx.fill();
      }

      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = mini ? 2.2 : (isFocused ? 2.6 : 2.2);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.shadowColor = mini ? "transparent" : `${color}45`;
      ctx.shadowBlur = mini ? 0 : (isFocused ? 7 : 2);
      ctx.beginPath();
      series.forEach((value, index) => {
        const px = x(index);
        const py = y(value);
        if (index === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }

    if (!mini && cursor !== null) {
      const index = Math.min(xMax, Math.max(0, cursor));
      const px = x(index);
      ctx.strokeStyle = "rgba(226, 232, 240, .42)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.moveTo(px + 0.5, plot.top);
      ctx.lineTo(px + 0.5, plot.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      for (const name of visible) {
        const series = seriesFor(name);
        if (index >= series.length) continue;
        ctx.fillStyle = "#0d1520";
        ctx.strokeStyle = colorFor(name);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, y(series[index]), 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();

    return { ...plot, xMax, x };
  }

  function renderMainChart() {
    mainGeometry = drawChart($("#overlay-canvas"), order, { cursor: state.cursor });
  }

  function renderTooltip(clientX, clientY) {
    const tooltip = $("#chart-tooltip");
    if (!mainGeometry || state.cursor === null) {
      tooltip.hidden = true;
      return;
    }
    const rows = visibleNames().map((name) => {
      const series = seriesFor(name);
      const value = series[state.cursor];
      return `<div class="tooltip-row"><i style="background:${colorFor(name)}"></i><strong>${name}</strong><span>${formatValue(value)}</span></div>`;
    }).join("");
    tooltip.innerHTML = `<div class="tooltip-head"><span>interval ${state.cursor}</span><span>${state.metric === "sigma" ? "σ" : "Δσ"}</span></div>${rows}`;
    tooltip.hidden = false;

    const stage = $("#chart-stage");
    const rect = stage.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const tooltipWidth = tooltip.offsetWidth || 240;
    const tooltipHeight = tooltip.offsetHeight || 250;
    const x = Math.min(rect.width - tooltipWidth - 18, Math.max(8, localX + 12));
    const y = Math.min(rect.height - tooltipHeight - 18, Math.max(8, localY + 12));
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  }

  function cursorFromPointer(event) {
    if (!mainGeometry) return;
    const rect = $("#overlay-canvas").getBoundingClientRect();
    const px = event.clientX - rect.left;
    const ratio = (px - mainGeometry.left) / mainGeometry.width;
    state.cursor = Math.min(mainGeometry.xMax, Math.max(0, Math.round(ratio * mainGeometry.xMax)));
    renderMainChart();
    renderTooltip(event.clientX, event.clientY);
  }

  function renderTabs() {
    const host = $("#regime-tabs");
    host.innerHTML = Object.entries(data.regimes).map(([key, regime]) =>
      `<button type="button" role="tab" aria-selected="${key === state.regime}" data-regime="${key}">${regime.short_name}</button>`
    ).join("");
    $$("button[data-regime]", host).forEach((button) => button.addEventListener("click", () => {
      state.regime = button.dataset.regime;
      state.cursor = null;
      renderAll();
    }));
  }

  function renderLegend() {
    const host = $("#legend");
    host.innerHTML = order.map((name) =>
      `<button type="button" aria-pressed="${!state.hidden.has(name)}" data-scheduler="${name}"><i class="legend-swatch" style="background:${colorFor(name)};color:${colorFor(name)}"></i>${name}</button>`
    ).join("");

    $$("button[data-scheduler]", host).forEach((button) => {
      const name = button.dataset.scheduler;
      button.addEventListener("click", (event) => {
        if (event.shiftKey) {
          state.hidden = new Set(order.filter((item) => item !== name));
        } else if (state.hidden.has(name)) {
          state.hidden.delete(name);
        } else if (state.hidden.size < order.length - 1) {
          state.hidden.add(name);
        }
        renderLegend();
        renderCharts();
      });
      button.addEventListener("pointerenter", () => {
        state.focus = name;
        renderMainChart();
      });
      button.addEventListener("pointerleave", () => {
        state.focus = null;
        renderMainChart();
      });
    });
  }

  function renderCards() {
    const schedules = currentSchedules();
    const host = $("#scheduler-cards");
    host.innerHTML = order.map((name, index) => {
      const scheduler = data.schedulers[name];
      const current = schedules[name];
      const sigmas = current.sigmas;
      const first = sigmas[0];
      const lastFinite = sigmas.length > 1 ? sigmas[sigmas.length - 2] : sigmas[0];
      return `<article class="scheduler-card" data-card="${name}">
        <div class="scheduler-card-head">
          <div class="scheduler-name"><i class="legend-swatch" style="background:${colorFor(name)};color:${colorFor(name)}"></i><h3>${name}</h3></div>
          <span class="scheduler-index">${String(index + 1).padStart(2, "0")}/${String(order.length).padStart(2, "0")}</span>
        </div>
        <p class="scheduler-description">${scheduler.description}</p>
        <div class="mini-chart"><canvas data-mini="${name}" aria-label="${name} scheduler chart"></canvas></div>
        <dl class="scheduler-meta">
          <div><dt>First σ</dt><dd>${formatValue(first)}</dd></div>
          <div><dt>Last finite σ</dt><dd>${formatValue(lastFinite)}</dd></div>
          <div><dt>Intervals</dt><dd>${current.evaluations}</dd></div>
        </dl>
        <div class="scheduler-card-footer"><code>${scheduler.parameters.replace("{steps}", state.steps)}</code><a href="${scheduler.source}">source ↗</a></div>
      </article>`;
    }).join("");
    $$("canvas[data-mini]", host).forEach((canvas) => drawChart(canvas, [canvas.dataset.mini], { mini: true }));
  }

  function renderControls() {
    const regime = data.regimes[state.regime];
    $("#chart-regime-name").textContent = regime.name;
    $("#regime-note").textContent = `${regime.parameters} · finite σ ${formatValue(regime.sigma_max)} → ${formatValue(regime.sigma_min)}`;
    $("#steps").value = state.steps;
    $("#steps-output").value = state.steps;
    $$('[data-metric]').forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.metric === state.metric)));
    $$('[data-scale]').forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.scale === state.scale)));
    $(".scale-control").setAttribute("aria-hidden", String(state.metric !== "sigma"));
    $("#chart-axis-note").textContent = state.metric === "sigma"
      ? `x: schedule interval · y: sigma${state.scale === "log" ? " (symlog + terminal zero)" : ""}`
      : "x: schedule interval · y: σᵢ − σᵢ₊₁";
  }

  function renderCharts() {
    renderMainChart();
    renderCards();
  }

  function renderAll() {
    updateHash();
    renderTabs();
    renderControls();
    renderLegend();
    renderCharts();
  }

  function downloadChart() {
    const canvas = $("#overlay-canvas");
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `comfyui-schedulers-${state.regime}-${state.metric}-${state.scale}-${state.steps}-steps.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  }

  async function copyViewLink() {
    const button = $("#copy-link");
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(location.href);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
    setTimeout(() => { button.textContent = original; }, 1200);
  }

  parseHash();

  const commit = data.generated_from.commit;
  $("#scheduler-count").textContent = order.length;
  $("#step-range").textContent = `${data.step_range.min}–${data.step_range.max}`;
  $("#source-commit").textContent = commit.slice(0, 8);
  $("#source-commit").href = sourceRoot();
  $("#source-repository").href = sourceRoot();
  $("#footer-source").href = sourceRoot();

  $$('[data-metric]').forEach((button) => button.addEventListener("click", () => {
    state.metric = button.dataset.metric;
    if (state.metric !== "sigma") state.scale = "linear";
    state.cursor = null;
    renderAll();
  }));

  $$('[data-scale]').forEach((button) => button.addEventListener("click", () => {
    state.scale = button.dataset.scale;
    state.cursor = null;
    renderAll();
  }));

  $("#steps").addEventListener("input", (event) => {
    state.steps = Number(event.target.value);
    state.cursor = null;
    renderControls();
    updateHash();
    renderCharts();
  });

  $("#reset-lines").addEventListener("click", () => {
    state.hidden.clear();
    state.focus = null;
    renderLegend();
    renderCharts();
  });
  $("#download-chart").addEventListener("click", downloadChart);
  $("#copy-link").addEventListener("click", copyViewLink);

  const mainCanvas = $("#overlay-canvas");
  mainCanvas.addEventListener("pointermove", cursorFromPointer);
  mainCanvas.addEventListener("pointerdown", cursorFromPointer);
  mainCanvas.addEventListener("pointerleave", () => {
    state.cursor = null;
    $("#chart-tooltip").hidden = true;
    renderMainChart();
  });

  mainCanvas.setAttribute("tabindex", "0");
  mainCanvas.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const xMax = mainGeometry?.xMax ?? state.steps;
    const base = state.cursor ?? Math.round(xMax / 2);
    state.cursor = Math.min(xMax, Math.max(0, base + (event.key === "ArrowRight" ? 1 : -1)));
    renderMainChart();
  });

  const resizeObserver = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      renderMainChart();
      $$("canvas[data-mini]").forEach((canvas) => drawChart(canvas, [canvas.dataset.mini], { mini: true }));
    });
  });
  resizeObserver.observe($("#chart-stage"));
  resizeObserver.observe($("#scheduler-cards"));

  renderAll();
})();
