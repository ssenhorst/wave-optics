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
 * @file `src/core/controls.js` defines the scene-level `controls` property: a panel of sliders that
 * is always on screen.
 *
 * A scene can already be manipulated by dragging things and by typing numbers into the object bar,
 * and for someone who knows what a ray diagram is, that is enough. For someone meeting one for the
 * first time it is not. They do not know that the lenses are the things to touch, they do not know
 * which of a lens's numbers matters, and an object bar that appears only once you have guessed
 * right is no help at all. A visible row of labelled sliders answers all three questions before the
 * first click: here is what you may change, here is what it is called, and here is how far it goes.
 *
 * The panel is also where read-only meters live — numbers the exercise is about but that are not
 * goals, such as how steeply the rays are striking the glass.
 */

const CONTROL_KEYS = ['title', 'note', 'groups', 'meters'];
const GROUP_KEYS = ['object', 'label', 'sliders'];
const SLIDER_KEYS = ['property', 'label', 'min', 'max', 'step', 'suffix', 'help'];
const METER_KEYS = ['source', 'label', 'screen', 'lenses', 'target', 'tolerance', 'min', 'max',
  'suffix', 'decimals', 'lowerIsBetter'];

/**
 * The quantities a meter can show.
 * @const {Array<string>}
 */
export const METER_SOURCES = ['maxIncidence', 'lensPowerSum', 'imageBlur', 'imageSize'];

/**
 * Validate a raw `controls` object coming from JSON.
 * @param {Object} raw - The raw value.
 * @returns {string|null} An error message, or null if the value is valid.
 */
export function validateControls(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'controls must be an object';

  for (const key in raw) {
    if (!CONTROL_KEYS.includes(key)) return `unknown controls key '${key}'`;
  }

  if (raw.groups !== undefined) {
    if (!Array.isArray(raw.groups)) return 'controls.groups must be an array';
    for (let i = 0; i < raw.groups.length; i++) {
      const group = raw.groups[i];
      if (!group || typeof group !== 'object') return `controls.groups[${i}] must be an object`;
      for (const key in group) {
        if (!GROUP_KEYS.includes(key)) return `controls.groups[${i}] has unknown key '${key}'`;
      }
      if (typeof group.object !== 'string') {
        return `controls.groups[${i}] requires 'object' (the name of the object it edits)`;
      }
      if (!Array.isArray(group.sliders) || group.sliders.length === 0) {
        return `controls.groups[${i}] requires a non-empty 'sliders'`;
      }
      for (let j = 0; j < group.sliders.length; j++) {
        const slider = group.sliders[j];
        if (!slider || typeof slider !== 'object') {
          return `controls.groups[${i}].sliders[${j}] must be an object`;
        }
        for (const key in slider) {
          if (!SLIDER_KEYS.includes(key)) {
            return `controls.groups[${i}].sliders[${j}] has unknown key '${key}'`;
          }
        }
        if (typeof slider.property !== 'string') {
          return `controls.groups[${i}].sliders[${j}] requires 'property'`;
        }
        if (typeof slider.min !== 'number' || typeof slider.max !== 'number') {
          return `controls.groups[${i}].sliders[${j}] requires numeric 'min' and 'max'`;
        }
        if (!(slider.max > slider.min)) {
          return `controls.groups[${i}].sliders[${j}] needs 'max' above 'min'`;
        }
      }
    }
  }

  if (raw.meters !== undefined) {
    if (!Array.isArray(raw.meters)) return 'controls.meters must be an array';
    for (let i = 0; i < raw.meters.length; i++) {
      const meter = raw.meters[i];
      if (!meter || typeof meter !== 'object') return `controls.meters[${i}] must be an object`;
      for (const key in meter) {
        if (!METER_KEYS.includes(key)) return `controls.meters[${i}] has unknown key '${key}'`;
      }
      if (!METER_SOURCES.includes(meter.source)) {
        return `controls.meters[${i}] has unknown source '${meter.source}' `
          + `(expected one of ${METER_SOURCES.join(', ')})`;
      }
    }
  }

  return null;
}

/**
 * @typedef {Object} MeterReading
 * @property {string} label - What to call it.
 * @property {number|null} value - What it reads, or null if there is nothing to read yet.
 * @property {string} text - The value formatted for display.
 * @property {number} fraction - Where the bar should sit, from 0 to 1.
 * @property {boolean} onTarget - Whether the value is where the scene wants it.
 */

/**
 * Read one meter from the current state of the scene.
 * @param {Object} meter - The meter definition.
 * @param {Scene} scene - The scene.
 * @param {function(Scene, Array<string>|null): number} totalLensPower - The power summing helper,
 * passed in so that this module does not depend on the imaging code.
 * @returns {MeterReading} What to show.
 */
export function readMeter(meter, scene, totalLensPower) {
  const decimals = meter.decimals ?? 2;
  const suffix = meter.suffix ?? '';
  const blank = { label: meter.label || meter.source, value: null, text: '—', fraction: 0, onTarget: false };

  const screenOf = () => (scene.objs || []).find(obj =>
    obj?.constructor?.type === 'ImageScreen' && (!meter.screen || obj.name === meter.screen));

  let value = null;
  if (meter.source === 'lensPowerSum') {
    value = totalLensPower(scene, meter.lenses || null) * 1000;
  } else {
    const screen = screenOf();
    const diagnostics = screen && screen.diagnostics;
    if (!diagnostics) return blank;
    if (meter.source === 'maxIncidence') value = diagnostics.maxIncidence;
    else if (meter.source === 'imageBlur') value = diagnostics.rms;
    else if (meter.source === 'imageSize') value = diagnostics.imageMagnification;
  }

  if (typeof value !== 'number' || !isFinite(value)) return blank;

  const min = meter.min ?? 0;
  const max = meter.max ?? Math.max(min + 1, value);
  let fraction = (value - min) / (max - min);
  fraction = Math.max(0, Math.min(1, fraction));
  // A meter where less is better reads more naturally when a full bar means "good".
  if (meter.lowerIsBetter) fraction = 1 - fraction;

  const onTarget = typeof meter.target === 'number'
    ? Math.abs(value - meter.target) <= (meter.tolerance ?? Math.abs(meter.target) * 0.02)
    : true;

  return {
    label: meter.label || meter.source,
    value,
    text: `${value.toFixed(decimals)}${suffix}`,
    fraction,
    onTarget,
  };
}
