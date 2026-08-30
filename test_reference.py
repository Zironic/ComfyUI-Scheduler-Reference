import math
import unittest

import generate


class SchedulerReferenceTests(unittest.TestCase):
    def setUp(self):
        self.regimes = {regime.key: regime for regime in generate.regimes()}

    def test_registry_matches_public_order(self):
        self.assertEqual(
            generate.SCHEDULERS,
            ("simple", "sgm_uniform", "karras", "exponential", "ddim_uniform", "beta", "normal", "linear_quadratic", "kl_optimal"),
        )

    def test_default_schedules_are_finite_monotone_and_terminal_zero(self):
        for regime in self.regimes.values():
            for name in generate.SCHEDULERS:
                with self.subTest(regime=regime.key, scheduler=name):
                    values = generate.schedule(name, regime, generate.DEFAULT_STEPS)
                    self.assertTrue(all(math.isfinite(value) for value in values))
                    self.assertEqual(values[-1], 0.0)
                    self.assertTrue(all(left >= right for left, right in zip(values, values[1:])))

    def test_default_schedule_interval_count(self):
        for regime in self.regimes.values():
            for name in generate.SCHEDULERS:
                with self.subTest(regime=regime.key, scheduler=name):
                    self.assertEqual(len(generate.schedule(name, regime, 20)) - 1, 20)

    def test_h3_video_parameters(self):
        h3 = self.regimes["flow-h3"]
        self.assertEqual(h3.shift, 12.0)
        self.assertAlmostEqual(h3.sigma_min, 12.0 / 1011.0)
        self.assertEqual(h3.sigma_max, 1.0)

    def test_krea2_flux_parameters(self):
        krea2 = self.regimes["krea2"]
        self.assertEqual(krea2.kind, "flux")
        self.assertEqual(krea2.shift, 1.15)
        self.assertEqual(len(krea2.sigmas), 10000)
        expected_min = math.exp(1.15) / (math.exp(1.15) + 9999.0)
        self.assertAlmostEqual(krea2.sigma_min, expected_min)
        self.assertEqual(krea2.sigma_max, 1.0)

    def test_classic_default_range(self):
        classic = self.regimes["classic-sd"]
        self.assertAlmostEqual(classic.sigma_min, 0.0291675, places=5)
        self.assertAlmostEqual(classic.sigma_max, 14.614642, places=5)

    def test_linear_quadratic_depends_only_on_sigma_max(self):
        normalized = generate.schedule("linear_quadratic", self.regimes["normalized"], 20)
        h3 = generate.schedule("linear_quadratic", self.regimes["flow-h3"], 20)
        self.assertEqual(normalized, h3)

    def test_source_links_are_revision_pinned(self):
        for name, (path, start, end) in generate.SOURCE_LINES.items():
            self.assertEqual(generate.source_url(path, start, end), f"https://github.com/Comfy-Org/ComfyUI/blob/{generate.COMFY_COMMIT}/{path}#L{start}-L{end}")


if __name__ == "__main__":
    unittest.main()
