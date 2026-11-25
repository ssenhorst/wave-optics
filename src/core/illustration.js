/*
 * Copyright 2025 The Wave Optics Simulation authors and contributors
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
 * @file `src/core/illustration.js` defines the scene-level `illustration` property, which draws a
 * picture at the object and another at the image an optical system forms of it.
 *
 * Ray diagrams say where an image is, but not what it looks like. Showing a recognisable picture,
 * scaled and flipped by the magnification the simulation actually produces, makes the size and the
 * orientation of the image immediate in a way that two converging points do not.
 *
 * The object is located by two light sources, named as `top` and `bottom`. The image is located by
 * two goals of the task, named in `imageGoals`, whose measured convergence points give where those
 * two ends of the object are imaged — so the picture follows the simulation rather than any
 * assumption about the optics.
 */

/**
 * The pictures the widget can draw, by name.
 * @const {Array<string>}
 */
export const ILLUSTRATION_PICTURES = ['church', 'apple'];

const ILLUSTRATION_KEYS = ['picture', 'top', 'bottom', 'imageGoals', 'showImage', 'opacity'];

/**
 * Validate a raw `illustration` object coming from JSON.
 * @param {Object} raw - The raw value.
 * @returns {string|null} An error message, or null if the value is valid.
 */
export function validateIllustration(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'illustration must be an object';

  for (const key in raw) {
    if (!ILLUSTRATION_KEYS.includes(key)) return `unknown illustration key '${key}'`;
  }
  if (!raw.picture) return "illustration requires 'picture'";
  if (!ILLUSTRATION_PICTURES.includes(raw.picture)) {
    return `unknown illustration picture '${raw.picture}' (expected one of ${ILLUSTRATION_PICTURES.join(', ')})`;
  }
  if (typeof raw.top !== 'string' || typeof raw.bottom !== 'string') {
    return "illustration requires 'top' and 'bottom', the names of the light sources at the ends of the object";
  }
  if (raw.imageGoals !== undefined) {
    if (!Array.isArray(raw.imageGoals) || raw.imageGoals.length !== 2
      || raw.imageGoals.some(id => typeof id !== 'string')) {
      return 'illustration.imageGoals must be two goal ids, for the top and the bottom of the image';
    }
  }
  if (raw.opacity !== undefined && !(raw.opacity >= 0 && raw.opacity <= 1)) {
    return 'illustration.opacity must be between 0 and 1';
  }
  return null;
}

/**
 * @typedef {Object} IllustrationPlacement
 * @property {Point} top - Where the top of the picture goes.
 * @property {Point} bottom - Where the bottom of the picture goes.
 * @property {boolean} flipped - Whether the picture is upside down, that is the image is inverted.
 */

/**
 * Where to draw the object picture: between the two light sources it is anchored to.
 * @param {Scene} scene - The scene.
 * @returns {IllustrationPlacement|null} The placement, or null if the sources are not in the scene.
 */
export function getObjectPlacement(scene) {
  const config = scene.illustration;
  if (!config) return null;

  const find = name => scene.objs.find(obj => obj.name === name);
  const top = find(config.top);
  const bottom = find(config.bottom);
  if (!top || !bottom) return null;

  const topPoint = top.p1 || (typeof top.x === 'number' ? { x: top.x, y: top.y } : null);
  const bottomPoint = bottom.p1 || (typeof bottom.x === 'number' ? { x: bottom.x, y: bottom.y } : null);
  if (!topPoint || !bottomPoint) return null;

  return { top: topPoint, bottom: bottomPoint, flipped: false };
}

/**
 * Where to draw the image picture: between the convergence points the named goals measured.
 * @param {Scene} scene - The scene.
 * @param {TaskStatus} status - The last evaluated task status.
 * @returns {IllustrationPlacement|null} The placement, or null if the image has not been measured.
 */
export function getImagePlacement(scene, status) {
  const config = scene.illustration;
  if (!config || !config.imageGoals || config.showImage === false || !status || !status.goals) return null;

  const pointOf = (goalId) => {
    const goal = status.goals.find(g => g.id === goalId);
    const mark = goal && (goal.marks || []).find(m => m.type === 'point');
    return mark && isFinite(mark.x) && isFinite(mark.y) ? { x: mark.x, y: mark.y } : null;
  };

  const top = pointOf(config.imageGoals[0]);
  const bottom = pointOf(config.imageGoals[1]);
  if (!top || !bottom) return null;

  const objectPlacement = getObjectPlacement(scene);
  if (!objectPlacement) return null;

  // The image is inverted when the two ends have swapped over relative to the object.
  const objectRise = objectPlacement.top.y - objectPlacement.bottom.y;
  const imageRise = top.y - bottom.y;
  const flipped = objectRise * imageRise < 0;

  return { top, bottom, flipped };
}
