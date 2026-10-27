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
 * @file `src/core/sceneObjs/glassShading.js` turns a refractive index into how solid the glass is
 * drawn, for every object that shades itself by its index: the polygon and curve glasses, the GRIN
 * materials, and the ideal lens drawn realistically.
 *
 * The scale is logarithmic, so that a material twice as far from the background index does not look
 * twice as dark, and is pinned so that ordinary glass at 1.5 lands on a fill of 0.2. That pinning is
 * what makes a weakly refracting material nearly invisible: at an index of 1.2 the fill is 0.09, and
 * on a black background that is close to nothing. `theme.glass.contrast` scales the whole thing, so
 * a scene built around a low-index material can be drawn legibly without changing what it is.
 */

/** The index that is drawn at {@link SHADE_REFERENCE_ALPHA}, at a contrast of 1. */
export const SHADE_REFERENCE_INDEX = 1.5;

/** The fill that {@link SHADE_REFERENCE_INDEX} is drawn with, at a contrast of 1. */
export const SHADE_REFERENCE_ALPHA = 0.2;

/**
 * How solid a material of a given refractive index should be drawn.
 *
 * The caller clamps the result to whatever range it can use, since what is sensible differs between
 * a fill, a colour subtraction and a sampled texture.
 * @param {number} refIndex - The refractive index, relative to the background. Values below 1 give a
 * negative result, which the callers that can show such a material take the absolute value of.
 * @param {Scene} scene - The scene, for `theme.glass.contrast`.
 * @returns {number} The fill, before clamping.
 */
export function glassShadeAlpha(refIndex, scene) {
  const contrast = scene?.theme?.glass?.contrast ?? 1;
  return Math.log(refIndex) / Math.log(SHADE_REFERENCE_INDEX) * SHADE_REFERENCE_ALPHA * contrast;
}
