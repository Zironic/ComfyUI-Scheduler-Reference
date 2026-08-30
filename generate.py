#!/usr/bin/env python3
"""Generate scheduler data and embeddable charts from ComfyUI's pinned contracts."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import math
import os
import subprocess
import textwrap
from dataclasses import dataclass
from pathlib import Path

os.environ.setdefault("SOURCE_DATE_EPOCH", "0")

import matplotlib
import numpy as np
from scipy.stats import beta as beta_distribution

matplotlib.use("Agg")
import matplotlib.pyplot as plt

matplotlib.rcParams.update({
    "font.family": "DejaVu Sans",
    "svg.hashsalt": "comfyui-scheduler-visualizer",
})


ROOT = Path(__file__).resolve().parent
COMFY_COMMIT = (ROOT / "COMFYUI_COMMIT").read_text(encoding="utf-8").strip()
DEFAULT_STEPS = 20
STEP_RANGE = range(2, 51)
LOG_LINTHRESH = 1e-4

SCHEDULERS = (
    "simple",
    "sgm_uniform",
    "karras",
    "exponential",
    "ddim_uniform",
    "beta",
    "normal",
    "linear_quadratic",
    "kl_optimal",
)

COLORS = {
    "simple": "#176b87",
    "sgm_uniform": "#d45b28",
    "karras": "#7656a8",
    "exponential": "#a83f68",
    "ddim_uniform": "#287a55",
    "beta": "#c28a14",
    "normal": "#4059ad",
    "linear_quadratic": "#d23b3b",
    "kl_optimal": "#6b6258",
}

SOURCE_LINES = {
    "simple": ("comfy/samplers.py", 645, 652),
    "sgm_uniform": ("comfy/samplers.py", 671, 693),
    "karras": ("comfy/k_diffusion/sampling.py", 23, 29),
    "exponential": ("comfy/k_diffusion/sampling.py", 32, 35),
    "ddim_uniform": ("comfy/samplers.py", 654, 669),
    "beta": ("comfy/samplers.py", 696, 708),
    "normal": ("comfy/samplers.py", 671, 693),
    "linear_quadratic": ("comfy/samplers.py", 711, 729),
    "kl_optimal": ("comfy/samplers.py", 732, 736),
}

DESCRIPTIONS = {
    "simple": "Evenly indexes the model's stored sigma table.",
    "sgm_uniform": "Uniform model timesteps, excluding the terminal timestep before zero.",
    "karras": "Karras rho schedule between the model's sigma bounds.",
    "exponential": "Uniform spacing in log sigma between the model's bounds.",
    "ddim_uniform": "Fixed-stride indexing through the stored sigma table.",
    "beta": "Beta(0.6, 0.6) quantiles mapped onto stored sigma indices.",
    "normal": "Uniform model timesteps including both model endpoints.",
    "linear_quadratic": "Linear then quadratic progress in normalized noise time.",
    "kl_optimal": "Uniform spacing in arctan(sigma), then mapped back with tan.",
}

PARAMETERS = {
    "simple": "steps={steps}",
    "sgm_uniform": "steps={steps}, sgm=True",
    "karras": "steps={steps}, rho=7",
    "exponential": "steps={steps}",
    "ddim_uniform": "steps={steps}",
    "beta": "steps={steps}, alpha=0.6, beta=0.6",
    "normal": "steps={steps}, sgm=False",
    "linear_quadratic": "steps={steps}, threshold_noise=0.025, linear_steps=floor(steps/2)",
    "kl_optimal": "steps={steps}",
}


@dataclass(frozen=True)
class SamplingRegime:
    key: str
    name: str
    short_name: str
    description: str
    parameters: str
    sigmas: np.ndarray
    kind: str
    shift: float = 1.0
    multiplier: float = 1000.0

    @property
    def sigma_min(self) -> float:
        return float(self.sigmas[0])

    @property
    def sigma_max(self) -> float:
        return float(self.sigmas[-1])

    def timestep(self, sigma: float) -> float:
        if self.kind == "flow":
            return sigma * self.multiplier
        if self.kind == "flux":
            return sigma
        distances = np.abs(math.log(sigma) - np.log(self.sigmas))
        return float(np.argmin(distances))

    def sigma(self, timestep: float) -> float:
        if self.kind == "flow":
            t = min(max(timestep / self.multiplier, 0.0), 1.0)
            return self.shift * t / (1.0 + (self.shift - 1.0) * t)
        if self.kind == "flux":
            t = min(max(timestep, np.finfo(np.float64).eps), 1.0)
            shift = math.exp(self.shift)
            return shift / (shift + (1.0 / t - 1.0))
        t = min(max(float(timestep), 0.0), len(self.sigmas) - 1)
        low = int(math.floor(t))
        high = int(math.ceil(t))
        weight = t - low
        return float(math.exp((1.0 - weight) * math.log(self.sigmas[low]) + weight * math.log(self.sigmas[high])))


def classic_sigmas() -> np.ndarray:
    betas = np.linspace(math.sqrt(0.00085), math.sqrt(0.012), 1000, dtype=np.float64) ** 2
    alphas_cumprod = np.cumprod(1.0 - betas)
    return np.sqrt((1.0 - alphas_cumprod) / alphas_cumprod)


def flow_sigmas(shift: float) -> np.ndarray:
    t = np.arange(1, 1001, dtype=np.float64) / 1000.0
    return shift * t / (1.0 + (shift - 1.0) * t)


def flux_sigmas(shift: float) -> np.ndarray:
    t = np.arange(1, 10001, dtype=np.float64) / 10000.0
    shifted = math.exp(shift)
    return shifted / (shifted + (1.0 / t - 1.0))


def regimes() -> tuple[SamplingRegime, ...]:
    return (
        SamplingRegime(
            "normalized",
            "Normalized scheduling space",
            "Normalized",
            "A neutral 1,000-point sigma table isolates scheduling policy from a particular model family.",
            "sigma table=linear 0.001..1, timesteps=1000, log interpolation",
            np.linspace(0.001, 1.0, 1000, dtype=np.float64),
            "discrete",
        ),
        SamplingRegime(
            "flow-h3",
            "Flow / MiniMax H3 video",
            "Flow / H3",
            "ComfyUI's MiniMax H3 video flow schedule; the packed audio stream has a separate shift and is not plotted.",
            "ModelSamplingDiscreteFlow, shift=12, multiplier=1000, timesteps=1000",
            flow_sigmas(12.0),
            "flow",
            shift=12.0,
        ),
        SamplingRegime(
            "krea2",
            "Krea 2",
            "Krea 2",
            "Krea 2 uses ComfyUI's Flux-style model sampling with its checkpoint-family shift setting.",
            "ModelSamplingFlux, shift=1.15, timesteps=10000; Krea2 config multiplier=1.0",
            flux_sigmas(1.15),
            "flux",
            shift=1.15,
            multiplier=1.0,
        ),
        SamplingRegime(
            "classic-sd",
            "Classic SD / SDXL",
            "Classic SD/SDXL",
            "The default discrete linear beta schedule used to show the high-sigma classic diffusion shape.",
            "ModelSamplingDiscrete, linear_start=0.00085, linear_end=0.012, timesteps=1000, zsnr=False",
            classic_sigmas(),
            "discrete",
        ),
    )


def simple_scheduler(model: SamplingRegime, steps: int) -> list[float]:
    stride = len(model.sigmas) / steps
    return [float(model.sigmas[-(1 + int(x * stride))]) for x in range(steps)] + [0.0]


def ddim_scheduler(model: SamplingRegime, steps: int) -> list[float]:
    x = 1
    if math.isclose(float(model.sigmas[x]), 0.0, abs_tol=0.00001):
        steps += 1
        values: list[float] = []
    else:
        values = [0.0]
    stride = max(len(model.sigmas) // steps, 1)
    while x < len(model.sigmas):
        values.append(float(model.sigmas[x]))
        x += stride
    return values[::-1]


def normal_scheduler(model: SamplingRegime, steps: int, sgm: bool = False) -> list[float]:
    start = model.timestep(model.sigma_max)
    end = model.timestep(model.sigma_min)
    append_zero = True
    if sgm:
        timesteps = np.linspace(start, end, steps + 1)[:-1]
    else:
        if math.isclose(model.sigma(end), 0.0, abs_tol=0.00001):
            steps += 1
            append_zero = False
        timesteps = np.linspace(start, end, steps)
    values = [model.sigma(float(t)) for t in timesteps]
    if append_zero:
        values.append(0.0)
    return values


def karras_scheduler(model: SamplingRegime, steps: int, rho: float = 7.0) -> list[float]:
    ramp = np.linspace(0.0, 1.0, steps)
    low = model.sigma_min ** (1.0 / rho)
    high = model.sigma_max ** (1.0 / rho)
    return list((high + ramp * (low - high)) ** rho) + [0.0]


def exponential_scheduler(model: SamplingRegime, steps: int) -> list[float]:
    return list(np.exp(np.linspace(math.log(model.sigma_max), math.log(model.sigma_min), steps))) + [0.0]


def beta_scheduler(model: SamplingRegime, steps: int, alpha: float = 0.6, beta: float = 0.6) -> list[float]:
    total_timesteps = len(model.sigmas) - 1
    positions = 1.0 - np.linspace(0.0, 1.0, steps, endpoint=False)
    timesteps = np.rint(beta_distribution.ppf(positions, alpha, beta) * total_timesteps)
    values: list[float] = []
    last_t = -1.0
    for timestep in timesteps:
        if timestep != last_t:
            values.append(float(model.sigmas[int(timestep)]))
        last_t = timestep
    return values + [0.0]


def linear_quadratic_scheduler(model: SamplingRegime, steps: int, threshold_noise: float = 0.025) -> list[float]:
    if steps == 1:
        schedule = [1.0, 0.0]
    else:
        linear_steps = steps // 2
        linear = [i * threshold_noise / linear_steps for i in range(linear_steps)]
        threshold_diff = linear_steps - threshold_noise * steps
        quadratic_steps = steps - linear_steps
        quadratic_coef = threshold_diff / (linear_steps * quadratic_steps**2)
        linear_coef = threshold_noise / linear_steps - 2 * threshold_diff / quadratic_steps**2
        const = quadratic_coef * linear_steps**2
        quadratic = [quadratic_coef * i**2 + linear_coef * i + const for i in range(linear_steps, steps)]
        schedule = [1.0 - x for x in linear + quadratic + [1.0]]
    return [value * model.sigma_max for value in schedule]


def kl_optimal_scheduler(model: SamplingRegime, steps: int) -> list[float]:
    positions = np.arange(steps, dtype=np.float64) / (steps - 1)
    values = np.tan(positions * math.atan(model.sigma_min) + (1.0 - positions) * math.atan(model.sigma_max))
    return list(values) + [0.0]


def schedule(name: str, model: SamplingRegime, steps: int) -> list[float]:
    handlers = {
        "simple": simple_scheduler,
        "sgm_uniform": lambda m, s: normal_scheduler(m, s, sgm=True),
        "karras": karras_scheduler,
        "exponential": exponential_scheduler,
        "ddim_uniform": ddim_scheduler,
        "beta": beta_scheduler,
        "normal": normal_scheduler,
        "linear_quadratic": linear_quadratic_scheduler,
        "kl_optimal": kl_optimal_scheduler,
    }
    return [float(value) for value in handlers[name](model, steps)]


def source_url(path: str, start: int, end: int) -> str:
    return f"https://github.com/Comfy-Org/ComfyUI/blob/{COMFY_COMMIT}/{path}#L{start}-L{end}"


def verify_comfy_source(comfy_source: Path) -> dict[str, str]:
    expected_files = {
        "comfy/samplers.py": comfy_source / "comfy" / "samplers.py",
        "comfy/model_sampling.py": comfy_source / "comfy" / "model_sampling.py",
        "comfy/supported_models.py": comfy_source / "comfy" / "supported_models.py",
        "comfy/k_diffusion/sampling.py": comfy_source / "comfy" / "k_diffusion" / "sampling.py",
    }
    for path in expected_files.values():
        if not path.is_file():
            raise SystemExit(f"Missing pinned ComfyUI source: {path}")

    try:
        revision = subprocess.check_output(
            ["git", "-C", str(comfy_source), "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL
        ).strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"Could not resolve ComfyUI revision at {comfy_source}: {error}") from error
    if revision != COMFY_COMMIT:
        raise SystemExit(f"Expected ComfyUI {COMFY_COMMIT}, found {revision}")

    samplers_text = expected_files["comfy/samplers.py"].read_text(encoding="utf-8")
    tree = ast.parse(samplers_text)
    scheduler_names: list[str] | None = None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "SCHEDULER_HANDLERS" for target in node.targets):
            scheduler_names = [key.value for key in node.value.keys if isinstance(key, ast.Constant)]
            break
    if scheduler_names != list(SCHEDULERS):
        raise SystemExit(f"Pinned SCHEDULER_HANDLERS changed: expected {list(SCHEDULERS)}, found {scheduler_names}")

    supported_text = expected_files["comfy/supported_models.py"].read_text(encoding="utf-8")
    h3_block = supported_text[supported_text.index("class MiniMaxH3"):supported_text.index("class HunyuanVideo")]
    if '"shift": 12.0' not in h3_block or '"audio_shift": 3.0' not in h3_block:
        raise SystemExit("Pinned MiniMaxH3 sampling settings changed")
    krea_block = supported_text[supported_text.index("class Krea2"):supported_text.index("class MageFlow")]
    if '"shift": 1.15' not in krea_block or '"multiplier": 1.0' not in krea_block:
        raise SystemExit("Pinned Krea2 sampling settings changed")

    required_symbols = {
        "comfy/samplers.py": ("simple_scheduler", "ddim_scheduler", "normal_scheduler", "beta_scheduler", "linear_quadratic_schedule", "kl_optimal_scheduler"),
        "comfy/model_sampling.py": ("ModelSamplingDiscrete", "ModelSamplingDiscreteFlow", "ModelSamplingFlux", "time_snr_shift", "flux_time_shift"),
        "comfy/k_diffusion/sampling.py": ("get_sigmas_karras", "get_sigmas_exponential"),
    }
    hashes: dict[str, str] = {}
    for relative, path in expected_files.items():
        text = path.read_text(encoding="utf-8")
        hashes[relative] = hashlib.sha256(text.encode("utf-8")).hexdigest()
        for symbol in required_symbols.get(relative, ()):
            if symbol not in text:
                raise SystemExit(f"Pinned source no longer contains {symbol} in {relative}")
    return hashes


def build_dataset(source_hashes: dict[str, str]) -> dict:
    regime_data = {}
    for model in regimes():
        schedules_by_steps = {}
        for steps in STEP_RANGE:
            scheduler_data = {}
            for name in SCHEDULERS:
                sigmas = schedule(name, model, steps)
                drops = [sigmas[index] - sigmas[index + 1] for index in range(len(sigmas) - 1)]
                scheduler_data[name] = {
                    "sigmas": [round(value, 10) for value in sigmas],
                    "drops": [round(value, 10) for value in drops],
                    "evaluations": len(sigmas) - 1,
                }
            schedules_by_steps[str(steps)] = scheduler_data
        regime_data[model.key] = {
            "name": model.name,
            "short_name": model.short_name,
            "description": model.description,
            "parameters": model.parameters,
            "sigma_min": round(model.sigma_min, 10),
            "sigma_max": round(model.sigma_max, 10),
            "schedules": schedules_by_steps,
        }

    scheduler_metadata = {}
    for name in SCHEDULERS:
        path, start, end = SOURCE_LINES[name]
        scheduler_metadata[name] = {
            "name": name,
            "description": DESCRIPTIONS[name],
            "parameters": PARAMETERS[name],
            "color": COLORS[name],
            "source": source_url(path, start, end),
        }

    return {
        "generated_from": {
            "repository": "https://github.com/Comfy-Org/ComfyUI",
            "commit": COMFY_COMMIT,
            "source_hashes": source_hashes,
        },
        "defaults": {"steps": DEFAULT_STEPS, "regime": "normalized", "metric": "sigma"},
        "step_range": {"min": min(STEP_RANGE), "max": max(STEP_RANGE)},
        "scheduler_order": list(SCHEDULERS),
        "schedulers": scheduler_metadata,
        "regimes": regime_data,
    }


def style_axes(axis, title: str, metric: str, details: str, scale: str = "linear") -> None:
    axis.set_title(title, loc="left", fontsize=15, fontweight="bold", pad=31, color="#162a3a")
    axis.text(0.0, 1.015, textwrap.fill(details, width=125), transform=axis.transAxes, fontsize=7.5, color="#566674", va="bottom")
    axis.set_xlabel("Schedule interval / nominal evaluation", color="#566674")
    if metric == "sigma":
        axis.set_ylabel("Sigma (symlog; linear below 1e-4)" if scale == "log" else "Sigma", color="#566674")
    else:
        axis.set_ylabel("Sigma drop per evaluation", color="#566674")
    axis.grid(True, color="#cbd5dc", linewidth=0.7, alpha=0.7)
    axis.set_axisbelow(True)
    axis.spines[["top", "right"]].set_visible(False)
    axis.spines[["bottom", "left"]].set_color("#9aaab5")
    axis.tick_params(colors="#566674")
    axis.set_facecolor("#f4f7f8")


def save_figure(figure, base_path: Path) -> None:
    base_path.parent.mkdir(parents=True, exist_ok=True)
    metadata = {"Creator": "ComfyUI Scheduler Visualizer"}
    figure.savefig(base_path.with_suffix(".svg"), bbox_inches="tight", facecolor=figure.get_facecolor(), metadata=metadata)
    figure.savefig(base_path.with_suffix(".png"), bbox_inches="tight", facecolor=figure.get_facecolor(), dpi=180, metadata=metadata)
    plt.close(figure)


def generate_assets(dataset: dict) -> None:
    for regime_key, regime in dataset["regimes"].items():
        values = regime["schedules"][str(DEFAULT_STEPS)]
        for metric, scale in (("sigma", "linear"), ("sigma", "log"), ("drops", "linear")):
            metric_slug = "sigma-log" if scale == "log" else ("sigma" if metric == "sigma" else "delta-sigma")
            figure, axis = plt.subplots(figsize=(11.5, 6.5), layout="constrained")
            figure.patch.set_facecolor("#f4f7f8")
            for name in SCHEDULERS:
                series = values[name]["sigmas" if metric == "sigma" else "drops"]
                axis.plot(range(len(series)), series, label=name, color=COLORS[name], linewidth=2.2)
            if scale == "log":
                axis.set_yscale("symlog", linthresh=LOG_LINTHRESH, linscale=0.9, base=10)
            style_axes(
                axis,
                f"{regime['name']} · all schedulers · steps={DEFAULT_STEPS}" + (" · log sigma + terminal zero" if scale == "log" else ""),
                metric,
                f"requested steps={DEFAULT_STEPS} · {regime['parameters']}",
                scale,
            )
            legend = axis.legend(ncol=3, frameon=True, fontsize=9, facecolor="#f4f7f8", framealpha=0.92)
            legend.get_frame().set_edgecolor("none")
            if metric == "sigma":
                terminal_index = max(len(values[name]["sigmas"]) - 1 for name in SCHEDULERS)
                axis.scatter([terminal_index], [0.0], marker="X", s=48, color="#d23b3b", zorder=8)
                terminal_label = "appended terminal zero · symlog linear zone ≤1e-4" if scale == "log" else "appended terminal zero"
                axis.annotate(terminal_label, (terminal_index, 0.0), xytext=(-7, 13), textcoords="offset points", ha="right", fontsize=7.5, color="#d23b3b")
            save_figure(figure, ROOT / "assets" / regime_key / f"all-schedulers-{metric_slug}")

            for name in SCHEDULERS:
                series = values[name]["sigmas" if metric == "sigma" else "drops"]
                figure, axis = plt.subplots(figsize=(8, 4.8), layout="constrained")
                figure.patch.set_facecolor("#f4f7f8")
                axis.plot(range(len(series)), series, color=COLORS[name], linewidth=2.8, marker="o", markersize=3)
                if scale == "log":
                    axis.set_yscale("symlog", linthresh=LOG_LINTHRESH, linscale=0.9, base=10)
                style_axes(
                    axis,
                    f"{name} · {regime['short_name']} · steps={DEFAULT_STEPS}" + (" · log sigma + terminal zero" if scale == "log" else ""),
                    metric,
                    f"{PARAMETERS[name].format(steps=DEFAULT_STEPS)} · {regime['parameters']}",
                    scale,
                )
                if metric == "sigma":
                    last_finite_index = len(series) - 2
                    last_finite = series[last_finite_index]
                    axis.scatter([len(series) - 1], [0.0], marker="X", s=48, color="#d23b3b", zorder=8)
                    axis.annotate(
                        f"last finite σ={last_finite:.6g}",
                        (last_finite_index, last_finite),
                        xytext=(-10, 25),
                        textcoords="offset points",
                        ha="right",
                        fontsize=7.5,
                        color="#162a3a",
                        arrowprops={"arrowstyle": "-", "color": "#8ea1ad", "linewidth": 0.8},
                    )
                    terminal_label = "appended 0 · linear zone ≤1e-4" if scale == "log" else "appended 0"
                    axis.annotate(terminal_label, (len(series) - 1, 0.0), xytext=(-6, 9), textcoords="offset points", ha="right", fontsize=7.5, color="#d23b3b")
                save_figure(figure, ROOT / "assets" / regime_key / f"{name}-{metric_slug}")


def write_outputs(dataset: dict) -> None:
    data_dir = ROOT / "data"
    data_dir.mkdir(exist_ok=True)
    encoded = json.dumps(dataset, indent=2, sort_keys=False) + "\n"
    (data_dir / "schedules.json").write_text(encoded, encoding="utf-8")
    compact = json.dumps(dataset, separators=(",", ":"))
    (data_dir / "schedules.js").write_text(f"window.SCHEDULER_DATA={compact};\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comfy-source", type=Path, required=True, help="Pinned ComfyUI checkout used to verify contracts")
    parser.add_argument("--skip-assets", action="store_true", help="Only generate JSON/JS data")
    args = parser.parse_args()

    hashes = verify_comfy_source(args.comfy_source.resolve())
    dataset = build_dataset(hashes)
    write_outputs(dataset)
    if not args.skip_assets:
        generate_assets(dataset)
    print(f"Generated {len(SCHEDULERS)} schedulers across {len(regimes())} regimes from ComfyUI {COMFY_COMMIT}")


if __name__ == "__main__":
    main()
