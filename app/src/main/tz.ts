/**
 * Pin the main-process timezone to the site's zone (Malaysia, GMT+8) BEFORE
 * anything else loads. This module is imported FIRST from index.ts.
 *
 * Why: the parking-flow fee calculator does ALL its day-of-week / time-window
 * / cut-off math in LOCAL time (getHours/getDay/getDate…). If the branch PC's
 * clock is on UTC (or any non-MYT zone), the gate would bill under the wrong
 * tariff window — e.g. a noon exit priced as 4am. Forcing TZ here makes the
 * fee math correct regardless of how the OS clock is configured, and matches
 * the tariff-parity harness (which runs with TZ='Asia/Kuala_Lumpur').
 *
 * Node runs tzset() when process.env.TZ is assigned, so every subsequent Date
 * in the main process honours this. NOTE: the renderer (Chromium) still uses
 * the OS clock for on-screen times — set the PC clock to KL, or format with
 * { timeZone: 'Asia/Kuala_Lumpur' }, where exact display matters.
 */
process.env.TZ = 'Asia/Kuala_Lumpur';
