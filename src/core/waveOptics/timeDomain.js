/*
 * Copyright 2026 The Wave Optics Simulation authors and contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @file Bookkeeping for the streaming time-domain engine: how finely the
 * interface histories are sampled in time, how long a window they keep, and
 * which steps a move of the clock needs filling.
 *
 * Every interface site re-radiates the field that reached it, so the field
 * beyond an interface at time `t` needs that site's incident field at
 * `t - n r / lambda`, for every distance `r` to the view. The GPU keeps this as
 * a ring buffer per interface: one row per site, one column per time step. All
 * interfaces share one clock, so a step index means the same instant in every
 * buffer.
 *
 * Nothing here is state the physics depends on. The field at any instant is a
 * pure function of time, because every signal is, so a buffer can always be
 * refilled from scratch — which is what a jump of the clock, a scene change or
 * a scrub backwards does.
 *
 * Kept free of GL so the arithmetic can be tested on its own.
 */

import { isContinuousWave } from './signals.js';

/**
 * Time steps per signal duration. The histories are interpolated linearly, so
 * the error at the peak of a Gaussian pulse is about `0.35 / STEPS^2`: 1% at
 * six steps.
 */
export const HISTORY_STEPS_PER_DURATION = 6;

/** The most time steps a history keeps, whatever the scene asks for. */
export const MAX_HISTORY_SLOTS = 2048;

/**
 * The most texels all histories together may hold. At eight bytes each this is
 * 128 MB, which bounds the memory a scene with very many interface sites can
 * take.
 */
export const MAX_HISTORY_TEXELS = 16 * 1024 * 1024;

/**
 * Steps kept beyond what the delays strictly need: one for the interpolation
 * partner of the oldest lookup, one because the newest step is rounded up past
 * the current time, and the rest so that a small scrub backwards can be served
 * from the window instead of refilling it.
 */
export const HISTORY_MARGIN_SLOTS = 16;

/**
 * The axis-aligned box around a set of points, grown in place.
 * @param {Object} box - `{xMin, xMax, yMin, yMax}`, possibly infinite.
 * @param {Array<{x: number, y: number}>} points
 * @returns {Object} The same box.
 */
function growBox(box, points) {
  for (const { x, y } of points) {
    if (x < box.xMin) box.xMin = x;
    if (x > box.xMax) box.xMax = x;
    if (y < box.yMin) box.yMin = y;
    if (y > box.yMax) box.yMax = y;
  }
  return box;
}

/**
 * The region the field grid covers, as two corner points.
 * @param {Object} grid - A `FieldGrid`.
 * @returns {Array<{x: number, y: number}>}
 */
function gridCorners(grid) {
  return [
    { x: grid.originX, y: grid.originY },
    {
      x: grid.originX + grid.stepX * (grid.width - 1),
      y: grid.originY + grid.stepY * (grid.height - 1),
    },
  ];
}

/**
 * The longest light travel time between two sets of points in subspace `j`, in
 * optical cycles, bounded by the diagonal of the box around both.
 * @param {Object} model
 * @param {number} j
 * @param {Array<{x: number, y: number}>} a
 * @param {Array<{x: number, y: number}>} b
 * @returns {number}
 */
function maxDelayBetween(model, j, a, b) {
  const box = { xMin: Infinity, xMax: -Infinity, yMin: Infinity, yMax: -Infinity };
  growBox(growBox(box, a), b);
  const diagonal = Math.hypot(box.xMax - box.xMin, box.yMax - box.yMin);
  return model.subspaces[j].refractiveIndex * diagonal / model.settings.wavelength;
}

/**
 * The longest delay of a field-pass lookup into subspace `j`'s history: from
 * any of its sites to anywhere in the view, or to any point a measurement
 * reads, which may lie outside the view.
 * @param {Object} model - As built by `buildWaveModel`.
 * @param {number} j - A subspace with an interface before it.
 * @returns {number} In optical cycles.
 */
export function viewDelay(model, j) {
  const targets = [...gridCorners(model.grid), ...(model.measurementPoints ?? [])];
  return maxDelayBetween(model, j, model.subspaces[j].surfaceSamples, targets);
}

/**
 * The longest delay of a chain-pass lookup into subspace `j`'s history: from
 * any of its sites to any site of the next interface, plus the longest delay
 * the next interface's own transmission adds.
 * @param {Object} model
 * @param {number} j
 * @returns {number} In optical cycles.
 */
export function chainDelay(model, j) {
  const next = model.subspaces[j + 1]?.surfaceSamples ?? [];
  if (next.length === 0) return 0;
  let siteDelay = 0;
  for (const site of next) siteDelay = Math.max(siteDelay, site.delay ?? 0);
  return maxDelayBetween(model, j, model.subspaces[j].surfaceSamples, next) + siteDelay;
}

/**
 * The time window the histories have to keep, in optical cycles.
 *
 * The first interface's history is exact over the whole window, because the
 * sources lighting it are evaluated in closed form. Each later one is filled
 * from the one before, so it is exact only once the window has run past the
 * delays of the chain leading to it. The field pass in subspace `J` looks back
 * by at most its view delay, so the window must cover, for every `J`, that
 * view delay plus the chain delays of every interface before it. A subspace
 * whose interface has no sites breaks the chain: what lies beyond it is lit by
 * closed-form sources again.
 *
 * @param {Object} model
 * @returns {number}
 */
export function requiredWindow(model) {
  let window = 0;
  let chain = 0;
  for (let j = 1; j < model.subspaces.length; j++) {
    if (model.subspaces[j].surfaceSamples.length === 0) {
      chain = 0;
      continue;
    }
    window = Math.max(window, chain + viewDelay(model, j));
    chain += chainDelay(model, j);
  }
  return window;
}

/**
 * The shortest duration of any time-dependent signal in a model, or `Infinity`
 * if there is none.
 * @param {Object} model
 * @returns {number}
 */
export function shortestSignalDuration(model) {
  let shortest = Infinity;
  for (const subspace of model.subspaces) {
    for (const item of [...subspace.primaries, ...(subspace.planeWaves ?? [])]) {
      if (!isContinuousWave(item.signal)) shortest = Math.min(shortest, item.signal.duration);
    }
  }
  return shortest;
}

/**
 * @typedef {Object} HistoryPlan
 * @property {number} step - Time between history samples, in optical cycles.
 * @property {number} slots - Time steps each history keeps.
 * @property {number} neededSlots - Of those, how many the delays require.
 * @property {number} window - The time the delays require, in optical cycles.
 * @property {boolean} isCoarse - Whether a limit forced a coarser step than
 *   the signals want.
 * @property {number} siteCount - Interface sites across all histories.
 */

/**
 * Work out the history sampling for a model: a window from
 * {@link requiredWindow}, sampled finely enough for the shortest signal unless
 * the texture limits force a coarser step.
 *
 * @param {Object} model - As built by `buildWaveModel`.
 * @param {Object} [limits]
 * @param {number} [limits.maxTextureSize=16384] - The GL implementation's
 *   `MAX_TEXTURE_SIZE`, which bounds a history's width.
 * @returns {HistoryPlan}
 */
export function planHistory(model, { maxTextureSize = 16384 } = {}) {
  let window = requiredWindow(model);
  let siteCount = 0;
  let widestBlocks = 1;
  for (let j = 1; j < model.subspaces.length; j++) {
    const sites = model.subspaces[j].surfaceSamples.length;
    if (sites === 0) continue;
    siteCount += sites;
    widestBlocks = Math.max(widestBlocks, historyShape(sites, 1, maxTextureSize).blocks);
  }

  const duration = shortestSignalDuration(model);
  let step = Number.isFinite(duration)
    ? duration / HISTORY_STEPS_PER_DURATION
    : Math.max(window, 1);
  // A scene without interfaces has nothing to keep, but the plan still has to
  // be usable.
  window = Math.max(window, step);

  const maxSlots = Math.max(HISTORY_MARGIN_SLOTS + 2, Math.min(
    MAX_HISTORY_SLOTS,
    Math.floor(maxTextureSize / widestBlocks),
    Math.floor(MAX_HISTORY_TEXELS / Math.max(siteCount, 1))
  ));

  let neededSlots = Math.ceil(window / step) + 2;
  let isCoarse = false;
  if (neededSlots + HISTORY_MARGIN_SLOTS > maxSlots) {
    // Keep the window and give up time resolution, rather than the other way
    // round: a short window would cut off light from the far side of the view.
    neededSlots = maxSlots - HISTORY_MARGIN_SLOTS;
    step = window / (neededSlots - 2);
    isCoarse = true;
  }

  return {
    step,
    slots: neededSlots + HISTORY_MARGIN_SLOTS,
    neededSlots,
    window,
    isCoarse,
    siteCount,
  };
}

/**
 * How one interface's history is laid out in its texture.
 *
 * Sites run down the rows and time steps across the columns. An interface with
 * more sites than a texture has rows is split into blocks placed side by side,
 * each `slots` columns wide.
 *
 * @param {number} siteCount
 * @param {number} slots
 * @param {number} maxTextureSize
 * @returns {{rows: number, blocks: number, width: number, height: number}}
 */
export function historyShape(siteCount, slots, maxTextureSize) {
  const rows = Math.max(1, Math.min(siteCount, maxTextureSize));
  const blocks = Math.max(1, Math.ceil(siteCount / rows));
  return { rows, blocks, width: blocks * slots, height: rows };
}

/**
 * The ring-buffer column a step lives in.
 * @param {number} stepIndex - Non-negative.
 * @param {number} slots
 * @returns {number}
 */
export function slotOf(stepIndex, slots) {
  return ((stepIndex % slots) + slots) % slots;
}

/**
 * The step a frame at time `t` needs filled up to: the first step at or after
 * `t`, so that a lookup at the current instant has a later sample to
 * interpolate towards.
 * @param {number} time
 * @param {number} epoch - The time of step zero.
 * @param {number} step
 * @returns {number}
 */
export function stepAtOrAfter(time, epoch, step) {
  // The tolerance stops a time that is a whole number of steps from rounding up
  // to the next one through floating-point noise.
  return Math.ceil((time - epoch) / step - 1e-9);
}

/**
 * Decide what moving the clock to `time` requires.
 *
 * @param {Object|null} state - `{epoch, newest}` from the previous frame, or
 *   null if the histories hold nothing yet.
 * @param {number} time
 * @param {HistoryPlan} plan
 * @returns {{refill: boolean, epoch: number, newest: number, from: number}}
 *   With `refill`, every slot is recomputed for the window ending at `newest`.
 *   Otherwise the steps `from` to `newest` inclusive are filled, which is
 *   nothing at all when `from > newest`.
 */
export function advanceHistory(state, time, plan) {
  if (state) {
    const target = stepAtOrAfter(time, state.epoch, plan.step);
    const slack = plan.slots - plan.neededSlots;
    if (target <= state.newest && target > state.newest - slack) {
      // Still inside the window: the steps it needs are all there.
      return { refill: false, epoch: state.epoch, newest: state.newest, from: state.newest + 1 };
    }
    if (target > state.newest && target - state.newest < plan.slots) {
      return { refill: false, epoch: state.epoch, newest: target, from: state.newest + 1 };
    }
  }

  // Start a fresh window whose newest step is the first at or after `time`, and
  // whose step zero is the oldest slot, so step indices stay non-negative.
  const newestTime = Math.ceil(time / plan.step - 1e-9) * plan.step;
  const epoch = newestTime - (plan.slots - 1) * plan.step;
  return { refill: true, epoch, newest: plan.slots - 1, from: 0 };
}

/**
 * The column ranges of the ring buffer covering steps `from` to `to`, split
 * where the range wraps round the end.
 * @param {number} from
 * @param {number} to
 * @param {number} slots
 * @returns {Array<{start: number, count: number}>}
 */
export function slotRanges(from, to, slots) {
  const count = to - from + 1;
  if (count <= 0) return [];
  if (count >= slots) return [{ start: 0, count: slots }];
  const start = slotOf(from, slots);
  const firstCount = Math.min(count, slots - start);
  const ranges = [{ start, count: firstCount }];
  if (firstCount < count) ranges.push({ start: 0, count: count - firstCount });
  return ranges;
}

/**
 * The time span of a time-dependent model, in optical cycles: from zero until
 * the latest signal, plus a few durations, has had time to cross the view.
 *
 * Noise has no instant of its own, so it contributes only its duration; the
 * span then just has to be long enough to watch it fluctuate.
 *
 * @param {Object} model - As built by `buildWaveModel`.
 * @returns {number}
 */
export function sceneTimeSpan(model) {
  const { grid, settings, subspaces } = model;
  let latest = 0;
  let largestIndex = settings.refractiveIndex;
  for (const subspace of subspaces) {
    largestIndex = Math.max(largestIndex, subspace.refractiveIndex);
    for (const item of [...subspace.primaries, ...(subspace.planeWaves ?? [])]) {
      const signal = item.signal;
      if (isContinuousWave(signal)) continue;
      const start = signal.type === 'noise' ? 0 : signal.delay;
      latest = Math.max(latest, start + 3 * signal.duration);
    }
  }
  const crossing = largestIndex * grid.extent / settings.wavelength;
  return latest + crossing;
}

/** Coherence times a time average over noise spans, at the least. */
export const NOISE_AVERAGE_COHERENCE_TIMES = 200;

/** Samples per shortest signal duration in a time average. */
export const AVERAGE_SAMPLES_PER_DURATION = 4;

/** The most instants a time average evaluates. */
export const MAX_AVERAGE_SAMPLES = 2000;

/**
 * The instants a time average of the intensity is taken over, in increasing
 * order.
 *
 * For deterministic signals the average runs over the scene's time span, from
 * before anything is emitted until the last of it has left the view, so it is
 * the time-integrated intensity — the pattern a slow detector records from a
 * pulse — divided by a fixed span. Noise has no end, so the average runs over
 * enough coherence times that its estimate settles: with 200 the remaining
 * scatter is a few percent.
 *
 * @param {Object} model
 * @returns {number[]}
 */
export function averagingTimes(model) {
  let span = sceneTimeSpan(model);
  // The longest coherence time is the one the average has to outlast.
  let longestNoise = 0;
  for (const subspace of model.subspaces) {
    for (const item of [...subspace.primaries, ...(subspace.planeWaves ?? [])]) {
      if (item.signal?.type === 'noise') longestNoise = Math.max(longestNoise, item.signal.duration);
    }
  }
  span = Math.max(span, NOISE_AVERAGE_COHERENCE_TIMES * longestNoise);

  const duration = shortestSignalDuration(model);
  const wanted = Number.isFinite(duration)
    ? Math.ceil(span * AVERAGE_SAMPLES_PER_DURATION / duration)
    : 1;
  const count = Math.max(1, Math.min(MAX_AVERAGE_SAMPLES, wanted));
  const step = span / count;
  return Array.from({ length: count }, (_, i) => (i + 0.5) * step);
}

export default {
  planHistory,
  historyShape,
  advanceHistory,
  slotRanges,
  slotOf,
};
