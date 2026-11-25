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
 * @file `src/core/imaging/screenRenderer.js` renders the picture an optical system actually throws
 * onto a screen.
 *
 * ### Why it is not a conventional renderer
 *
 * A path tracer asked for this picture would start at the screen and look back through the glass for
 * the object, which is the hardest question it can be asked: a sharp image on a diffuse screen is a
 * caustic, and caustics are the case Monte Carlo rendering converges on most slowly. Tracing the
 * other way, from the object towards the screen, is both the physical direction and by far the
 * cheaper one, and it is what an optical designer does anyway.
 *
 * ### The point-spread function, as a function of field height
 *
 * Tracing a ray for every pixel of the picture from every point of the pupil would be wasteful,
 * because a rotationally symmetric system does the same thing to every object point at the same
 * distance from the axis. So the renderer traces a spot diagram — the pattern a single object point
 * is smeared into — for a modest number of field heights, and builds the picture by stamping that
 * pattern, rotated to the right azimuth and interpolated between neighbouring heights, once per
 * object pixel.
 *
 * That is a field-dependent point-spread function, which is exactly the right model here: the
 * aberrations this exercise is about are precisely the ways the spot changes with field height and
 * with aperture. Nothing is assumed to be shift invariant, so coma still looks like coma at the edge
 * of the apple while the centre stays sharp — the thing a plain blur would get wrong.
 *
 * ### What it does not model
 *
 * Diffraction, scattering, interference and partial reflection at the surfaces are all absent: this
 * is geometrical optics, as the ray diagram beside it is. In the regime the exercise lives in, with
 * an aperture wide enough that the spots are tens of units across, geometrical blur dominates
 * diffraction by orders of magnitude, so the picture is honest about what limits it.
 */

import { traceRay, propagateToPlane, normalizedDirection } from './sequentialTrace.js';

/** The golden angle, which spreads successive pupil samples as evenly as a spiral can. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * A cheap deterministic hash, used to jitter the pupil sampling.
 *
 * A bare spiral is beautifully uniform and exactly the wrong thing here. Every field height would be
 * sampled at the same pupil points, so neighbouring spot diagrams would be copies of each other
 * displaced slightly, and stamping them side by side across the picture turns the ladder of field
 * heights into a set of concentric rings — an artefact that looks like interference, which in an
 * optics teaching tool is about the worst artefact available. Jittering each sample inside its own
 * equal-area cell, with a different offset at each field height, replaces the rings with a little
 * noise. The hash keeps it reproducible, so the same system always renders the same picture.
 * @param {number} a - The first key.
 * @param {number} b - The second key.
 * @returns {number} A number in [0, 1).
 */
function hashedRandom(a, b) {
  let h = (a * 0x27d4eb2d) ^ (b * 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Rendering presets. The preview is what is drawn while something is being dragged, and the full
 * quality is what settles once it stops.
 * @const {Object<string, Object>}
 */
export const RENDER_QUALITY = {
  preview: { fieldSamples: 8, pupilSamples: 120, outputSize: 96, objectSize: 56 },
  full: { fieldSamples: 22, pupilSamples: 700, outputSize: 220, objectSize: 150 },
};

/**
 * What the GPU renderer can afford instead. Scattering light is what the GPU is good at, so the
 * pupil can be sampled finely enough that the blur comes out smooth rather than grainy, and the
 * picture can be drawn at a resolution that stands up to being looked at closely.
 * @const {Object<string, Object>}
 */
export const GPU_RENDER_QUALITY = {
  preview: { fieldSamples: 10, pupilSamples: 300, outputSize: 192, objectSize: 96 },
  full: { fieldSamples: 20, pupilSamples: 900, outputSize: 288, objectSize: 150 },
};

/**
 * @typedef {Object} SpotDiagram
 * @property {number} fieldRadius - The distance of the object point from the axis.
 * @property {Float32Array} landings - Where each pupil sample landed on the screen, as `[u, v, ...]`
 * pairs in a frame whose v axis points away from the optical axis. It is indexed by the pupil
 * sample, not packed, so entry `i` means the same point of the pupil at every field height.
 * @property {Uint8Array} valid - Whether each pupil sample reached the screen at all.
 * @property {number} centroid - Where the centroid of the spot lands, as a distance from the axis.
 * @property {number} throughput - The fraction of the rays from this point that reached the screen,
 * which is the vignetting.
 * @property {number} rms - The root-mean-square radius of the spot.
 */

/**
 * Trace the spot diagram of one object point.
 *
 * Every field height is traced through the *same* pupil points, which is what lets the renderer
 * treat a fixed pupil sample as a continuous map from the object plane to the screen and simply
 * interpolate it. That is both cheaper and better behaved than blending whole spot diagrams:
 * blending two clouds that sit at different places puts a pixel's light in two places at once,
 * which draws the ladder of field heights into the picture as concentric rings.
 * @param {Array<Surface>} surfaces - The prescription.
 * @param {number} objectZ - The object plane.
 * @param {number} fieldRadius - How far the object point is from the axis.
 * @param {number} screenZ - The screen plane.
 * @param {number} pupilRadius - The radius of the disc the rays are aimed at.
 * @param {number} pupilZ - The plane that disc lies in.
 * @param {number} pupilSamples - How many rays to trace.
 * @param {number} ambientIndex - The index in front of the system.
 * @returns {SpotDiagram} The spot. A spot no ray reached has `throughput` 0.
 */
function traceSpot(surfaces, objectZ, fieldRadius, screenZ, pupilRadius, pupilZ, pupilSamples, ambientIndex, stats) {
  const landings = new Float32Array(pupilSamples * 2);
  const valid = new Uint8Array(pupilSamples);
  let count = 0;
  let sumU = 0;
  let sumV = 0;

  for (let i = 0; i < pupilSamples; i++) {
    // Equal-area spiral sampling of the pupil disc, jittered within each sample's own cell so that
    // the spiral's own concentric structure does not print itself onto the blur. Every ray carries
    // the same energy, so the spot diagram doubles as the intensity distribution with no per-ray
    // weight. The jitter is a function of the sample index alone, so it is the same at every field
    // height, as the interpolation requires.
    const r = pupilRadius * Math.sqrt((i + hashedRandom(i, 0x51ed)) / pupilSamples);
    const theta = i * GOLDEN_ANGLE + hashedRandom(i, 0x9e37) * 0.6;
    const targetU = r * Math.cos(theta);
    const targetV = r * Math.sin(theta);

    const result = traceRay(surfaces, {
      x: 0, y: fieldRadius, z: objectZ,
      ...normalizedDirection(targetU, targetV - fieldRadius, pupilZ - objectZ),
    }, ambientIndex, stats);
    if (!result.ray) continue;

    const landed = propagateToPlane(result.ray, screenZ);
    if (!landed) continue;

    landings[i * 2] = landed.x;
    landings[i * 2 + 1] = landed.y;
    valid[i] = 1;
    sumU += landed.x;
    sumV += landed.y;
    count++;
  }

  if (count === 0) {
    return { fieldRadius, landings, valid, centroid: 0, throughput: 0, rms: 0 };
  }

  const centroidU = sumU / count;
  const centroidV = sumV / count;

  let sumSquared = 0;
  for (let i = 0; i < pupilSamples; i++) {
    if (!valid[i]) continue;
    const du = landings[i * 2] - centroidU;
    const dv = landings[i * 2 + 1] - centroidV;
    sumSquared += du * du + dv * dv;
  }

  return {
    fieldRadius,
    landings,
    valid,
    // The centroid is on the meridional plane by symmetry; its u component is sampling noise.
    centroid: centroidV,
    throughput: count / pupilSamples,
    rms: Math.sqrt(sumSquared / count),
  };
}

/**
 * Trace the spot diagram at a ladder of field heights, which is the whole optical content of the
 * picture.
 * @param {Object} params - The system and the sampling.
 * @param {Array<Surface>} params.surfaces - The prescription.
 * @param {number} params.objectZ - The object plane.
 * @param {number} params.objectRadius - The distance from the axis to the far corner of the object.
 * @param {number} params.screenZ - The screen plane.
 * @param {number} params.ambientIndex - The index in front of the system.
 * @param {number} params.fieldSamples - How many field heights to trace.
 * @param {number} params.pupilSamples - How many rays per field height.
 * @returns {{spots: Array<SpotDiagram>, rms: number, maxIncidence: number}|null} The spots, their
 * area-weighted mean RMS radius, and the steepest angle in degrees at which any traced ray met a
 * glass surface, or null if the system forms no image at all.
 */
export function traceSpotField(params) {
  const {
    surfaces, objectZ, objectRadius, screenZ, ambientIndex,
    fieldSamples, pupilSamples,
  } = params;

  if (!surfaces.length) return null;

  // The rays are aimed at the first surface, and the apertures further in do the rest: a ray that
  // the real stop would clip is traced and then stopped there, which is what makes the vignetting
  // towards the corners of the picture come out by itself.
  const pupilZ = surfaces[0].z;
  const pupilRadius = surfaces[0].semiAperture;

  const spots = [];
  const stats = { maxIncidence: 0 };
  let weightedSquares = 0;
  let weight = 0;

  for (let k = 0; k < fieldSamples; k++) {
    const fieldRadius = objectRadius * k / (fieldSamples - 1);
    const spot = traceSpot(
      surfaces, objectZ, fieldRadius, screenZ,
      pupilRadius, pupilZ, pupilSamples, ambientIndex, stats
    );
    spots.push(spot);

    // A field height nothing reaches contributes no blur to average — the picture simply goes dark
    // there, which is what vignetting looks like.
    if (!spot.throughput) continue;

    // Field heights stand for annuli, so each one's share of the picture grows with its radius.
    const w = Math.max(fieldRadius, objectRadius / fieldSamples);
    weightedSquares += w * spot.rms * spot.rms;
    weight += w;
  }

  if (!weight) return null;
  return {
    spots,
    rms: Math.sqrt(weightedSquares / weight),
    maxIncidence: stats.maxIncidence * 180 / Math.PI,
  };
}

/**
 * @typedef {Object} ObjectTexture
 * @property {Uint8ClampedArray} data - RGBA pixels, row major.
 * @property {number} width - The width in pixels.
 * @property {number} height - The height in pixels.
 */

/**
 * Render the picture formed on the screen.
 *
 * Each pixel of the object is a point source: its colour is scattered over the screen in the shape
 * of the spot diagram for its distance from the axis, so the rendered picture carries the object's
 * own colours through the aberrations rather than being a greyscale blur of them. That is what makes
 * the half-red, half-green apple worth using — the two halves blur into each other at the boundary
 * exactly as far as the system is bad.
 *
 * @param {Object} params - The render.
 * @param {ObjectTexture} params.texture - The object, as pixels.
 * @param {number} params.objectHalfHeight - Half the height of the object in scene units.
 * @param {number} [params.objectOffsetY=0] - How far the centre of the object sits off the optical
 * axis. An object straddling the axis images differently from one standing on it, and which of the
 * two a scene has is a property of the scene, not of the renderer.
 * @param {Array<SpotDiagram>} params.spots - The spot diagrams from {@link traceSpotField}.
 * @param {number} params.objectRadius - The field radius the last spot was traced at.
 * @param {number} params.screenHalfSize - Half the width and height of the screen in scene units.
 * @param {number} params.outputSize - The side of the rendered picture, in pixels.
 * @returns {{data: Uint8ClampedArray, width: number, height: number, clipped: boolean}} The picture.
 */
export function renderScreenImage(params) {
  const {
    texture, objectHalfHeight, spots, objectRadius, screenHalfSize, outputSize,
    objectOffsetY = 0,
  } = params;

  const out = outputSize;
  const accum = new Float32Array(out * out * 3);
  const unitsPerPixel = (2 * screenHalfSize) / out;
  const pixelsPerUnit = 1 / unitsPerPixel;

  // Scene units per pixel of the object texture, so that the texture spans the object's height.
  const objectScale = (2 * objectHalfHeight) / texture.height;
  const halfWidth = texture.width * objectScale / 2;

  const fieldStep = objectRadius / (spots.length - 1);
  const pupilSamples = spots[0].valid.length;
  let clipped = false;
  let energySeen = 0;

  for (let iy = 0; iy < texture.height; iy++) {
    // The texture's first row is the top of the object, which is the most negative scene y.
    const oy = (iy + 0.5) * objectScale - objectHalfHeight + objectOffsetY;

    for (let ix = 0; ix < texture.width; ix++) {
      const base = (iy * texture.width + ix) * 4;
      const alpha = texture.data[base + 3] / 255;
      if (alpha < 0.004) continue;

      const red = texture.data[base] * alpha;
      const green = texture.data[base + 1] * alpha;
      const blue = texture.data[base + 2] * alpha;
      if (red + green + blue <= 0) continue;

      const ox = (ix + 0.5) * objectScale - halfWidth;
      const radius = Math.hypot(ox, oy);

      // The frame the spot diagram was traced in: v away from the axis, u across it.
      const ex = radius > 1e-9 ? ox / radius : 0;
      const ey = radius > 1e-9 ? oy / radius : 1;

      // Between which two traced field heights this pixel sits.
      const position = Math.min(radius / fieldStep, spots.length - 1 - 1e-6);
      const k0 = position | 0;
      const k1 = k0 + 1 < spots.length ? k0 + 1 : k0;
      const t = position - k0;

      const near = spots[k0];
      const far = spots[k1];
      const nearLandings = near.landings;
      const farLandings = far.landings;
      const nearValid = near.valid;
      const farValid = far.valid;

      // Energy is conserved and divided over the whole pupil, not over the rays that happened to
      // survive, so a vignetted point simply arrives dimmer.
      const perSample = 1 / pupilSamples;
      const wr = red * perSample;
      const wg = green * perSample;
      const wb = blue * perSample;

      const exS = ex * pixelsPerUnit;
      const eyS = ey * pixelsPerUnit;
      const originX = screenHalfSize * pixelsPerUnit;
      const originY = screenHalfSize * pixelsPerUnit;

      for (let i = 0, o = 0; i < pupilSamples; i++, o += 2) {
        // One pupil point, followed from the object plane to the screen. Because both field
        // heights were traced through this same pupil point, the two landings are two samples of
        // one smooth map and can simply be interpolated — no blending of whole spot diagrams, and
        // so none of the ring artefacts that blending produces.
        const hasNear = nearValid[i];
        const hasFar = farValid[i];
        if (!hasNear && !hasFar) continue;

        let u;
        let v;
        let weightHere = 1;
        if (hasNear && hasFar) {
          u = nearLandings[o] + (farLandings[o] - nearLandings[o]) * t;
          v = nearLandings[o + 1] + (farLandings[o + 1] - nearLandings[o + 1]) * t;
        } else if (hasNear) {
          // The pupil point is clipped on one side of this pixel's field height, so it carries
          // only its share of the light: this is the soft edge of the vignetting.
          u = nearLandings[o];
          v = nearLandings[o + 1];
          weightHere = 1 - t;
        } else {
          u = farLandings[o];
          v = farLandings[o + 1];
          weightHere = t;
        }

        // Bounds are checked before truncation, since truncating towards zero would otherwise
        // fold the row and column just off the top-left edge back onto the picture.
        const fx = originX + u * eyS + v * exS;
        const fy = originY - u * exS + v * eyS;
        if (fx < 0 || fy < 0 || fx >= out || fy >= out) {
          clipped = true;
          continue;
        }

        const target = ((fy | 0) * out + (fx | 0)) * 3;
        accum[target] += wr * weightHere;
        accum[target + 1] += wg * weightHere;
        accum[target + 2] += wb * weightHere;
        energySeen += (wr + wg + wb) * weightHere;
      }
    }
  }
  const energy = energySeen;

  return { ...develop(accum, out, pixelsPerUnit), clipped, energy };
}

/**
 * Turn the accumulated energy into pixels.
 *
 * The exposure is set from a high percentile of the picture rather than from its peak, so that a
 * single hot pixel cannot darken everything else, and so that a badly blurred image stays visible
 * instead of fading to black — the student is being asked to judge sharpness, and an image they
 * cannot see tells them nothing. Contrast between neighbouring parts of the picture, which is what
 * blur actually destroys, survives the rescaling untouched.
 * @param {Float32Array} accum - The accumulated RGB energy.
 * @param {number} size - The side of the picture in pixels.
 * @param {number} pixelsPerUnit - The resolution, used only to report it back.
 * @returns {{data: Uint8ClampedArray, width: number, height: number}} The picture.
 */
function develop(accum, size, pixelsPerUnit) {
  const luminance = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    luminance[i] = 0.2126 * accum[i * 3] + 0.7152 * accum[i * 3 + 1] + 0.0722 * accum[i * 3 + 2];
  }

  const sorted = Float32Array.from(luminance).sort();
  const exposure = sorted[Math.floor(sorted.length * 0.995)] || sorted[sorted.length - 1] || 1;
  const gain = exposure > 0 ? 1 / exposure : 0;

  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 3; c++) {
      // sRGB-ish gamma, so that the faint skirts of an aberrated spot are visible at all.
      const value = Math.max(0, accum[i * 3 + c] * gain);
      data[i * 4 + c] = 255 * Math.pow(Math.min(1, value), 1 / 2.2);
    }
    data[i * 4 + 3] = 255;
  }

  return { data, width: size, height: size, pixelsPerUnit };
}

/**
 * How good the picture is, as a number between 0 and 1 suitable for a progress bar.
 *
 * The measure is the RMS spot radius against a reference: the size of the blur the author considers
 * acceptable. It is deliberately not a score out of a hundred and not a ranking — the exercise is
 * about understanding why splitting the power helps, and a leaderboard would turn it into a search.
 * @param {number} rms - The area-weighted RMS spot radius.
 * @param {number} reference - The RMS radius that counts as a good image.
 * @returns {number} The quality, from 0 to 1.
 */
export function imageQuality(rms, reference) {
  if (!(rms > 0)) return 1;
  if (!(reference > 0)) return 0;
  // A ratio-based score, so that halving the blur is worth the same wherever you start from.
  return Math.max(0, Math.min(1, reference / (reference + Math.max(0, rms - reference))));
}
