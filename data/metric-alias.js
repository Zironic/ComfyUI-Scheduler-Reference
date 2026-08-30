(() => {
  "use strict";

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
