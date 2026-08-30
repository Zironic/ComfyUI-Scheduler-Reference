(() => {
  "use strict";

  // The generated dataset stores the sigma series as `sigmas`, while the
  // interactive UI's metric selector uses the singular metric id `sigma`.
  // Normalize that schema once before app.js runs so both Sigma and Δsigma
  // resolve to arrays from the first paint onward.
  const data = window.SCHEDULER_DATA;
  if (!data?.regimes) return;

  for (const regime of Object.values(data.regimes)) {
    for (const stepSchedules of Object.values(regime.schedules || {})) {
      for (const scheduler of Object.values(stepSchedules || {})) {
        if (scheduler && Array.isArray(scheduler.sigmas) && !Array.isArray(scheduler.sigma)) {
          scheduler.sigma = scheduler.sigmas;
        }
      }
    }
  }
})();
