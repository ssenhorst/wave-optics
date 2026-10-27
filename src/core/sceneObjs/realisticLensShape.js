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
 * @file `src/core/sceneObjs/realisticLensShape.js` draws an ideal lens as a piece of glass.
 *
 * An ideal lens obeys the lens equation exactly, which is what makes it useful for teaching, but a
 * line with two arrowheads does not look like a lens and says nothing about the shape a given focal
 * length implies. This module works out the shape a real lens of that focal length would have, from
 * the lens maker's equation and a refractive index, and draws it. Only the drawing changes: the rays
 * are still traced ideally.
 */

import geometry from '../geometry.js';
import { glassShadeAlpha } from './glassShading.js';

/**
 * @typedef {Object} LensShape
 * @property {Point} frontRim - The rim at the `p1` end on the front (incoming) side.
 * @property {Point} frontRim2 - The rim at the `p2` end on the front side.
 * @property {Point} backRim - The rim at the `p2` end on the back side.
 * @property {Point} backRim2 - The rim at the `p1` end on the back side.
 * @property {Point} frontVertex - The deepest point of the front surface.
 * @property {Point} backVertex - The deepest point of the back surface.
 */

/**
 * The radii of curvature a real lens of this focal length would have.
 *
 * With both surfaces curved the lens is taken to be symmetric; with one flat, all the power is on
 * the other. The thin-lens maker's equation is enough here, since the result is only a drawing.
 * @param {number} focalLength - The focal length of the ideal lens.
 * @param {number} refIndex - The refractive index the shape is drawn for.
 * @param {'both'|'front'|'back'} curvedSurfaces - Which surfaces are curved.
 * @returns {{r1: number, r2: number}} The radii, infinite for a flat surface.
 */
export function getShapeRadii(focalLength, refIndex, curvedSurfaces) {
  const power = (refIndex - 1) * focalLength;
  if (curvedSurfaces === 'front') return { r1: power, r2: Infinity };
  if (curvedSurfaces === 'back') return { r1: Infinity, r2: -power };
  return { r1: 2 * power, r2: -2 * power };
}

/**
 * How deep a surface of a given radius cuts into an aperture.
 * @param {number} radius - The radius of curvature, possibly infinite.
 * @param {number} halfAperture - Half the height of the lens.
 * @returns {number} The sagitta, never more than the half aperture so the drawing stays sensible.
 */
function sagitta(radius, halfAperture) {
  if (!isFinite(radius) || radius === 0) return 0;
  const r = Math.abs(radius);
  if (r <= halfAperture) return halfAperture;
  return Math.min(halfAperture, r - Math.sqrt(r * r - halfAperture * halfAperture));
}

/**
 * Work out the outline of the lens.
 * @param {Object} lens - An object with `p1`, `p2` and `focalLength`.
 * @param {number} refIndex - The refractive index the shape is drawn for.
 * @param {'both'|'front'|'back'} curvedSurfaces - Which surfaces are curved.
 * @param {number} lengthScale - The length scale of the scene, so the rim is visible at any zoom.
 * @param {number} [thickness=0] - The centre thickness, or 0 to choose one that suits the shape.
 * @returns {LensShape|null} The outline, or null if the lens is degenerate.
 */
export function getLensShape(lens, refIndex, curvedSurfaces, lengthScale, thickness = 0) {
  const dx = lens.p2.x - lens.p1.x;
  const dy = lens.p2.y - lens.p1.y;
  const length = Math.hypot(dx, dy);
  if (!(length > 0) || !isFinite(lens.focalLength) || lens.focalLength === 0) return null;

  const halfAperture = length / 2;
  const par = geometry.point(dx / length, dy / length);
  const per = geometry.point(par.y, -par.x);
  const center = geometry.midpoint(lens.p1, lens.p2);

  const { r1, r2 } = getShapeRadii(lens.focalLength, Math.max(1.01, refIndex), curvedSurfaces);
  const s1 = sagitta(r1, halfAperture);
  const s2 = sagitta(r2, halfAperture);

  // The thinnest part of the lens, so that a converging lens still has a rim and a diverging one
  // still has a middle.
  const minimum = thickness > 0 ? thickness : Math.max(2 * lengthScale, halfAperture * 0.1);

  let rimHalf, frontDepth, backDepth;
  if (lens.focalLength > 0) {
    // Converging: thin at the rim, bulging out at the vertices.
    rimHalf = minimum / 2;
    frontDepth = rimHalf + s1;
    backDepth = rimHalf + s2;
  } else {
    // Diverging: thin in the middle, thick at the rim.
    frontDepth = minimum / 2;
    backDepth = minimum / 2;
    rimHalf = minimum / 2 + Math.max(s1, s2);
  }

  const at = (alongPar, alongPer) => geometry.point(
    center.x + par.x * alongPar + per.x * alongPer,
    center.y + par.y * alongPar + per.y * alongPer
  );

  return {
    frontRim: at(-halfAperture, -rimHalf),
    frontRim2: at(halfAperture, -rimHalf),
    backRim: at(halfAperture, rimHalf),
    backRim2: at(-halfAperture, rimHalf),
    frontVertex: at(0, -frontDepth),
    backVertex: at(0, backDepth),
  };
}

/**
 * Trace the outline of the lens onto a context, as a closed path ready to be filled or stroked.
 *
 * Each surface is a quadratic through its vertex, which is indistinguishable from the arc at these
 * sizes and degenerates to a straight line by itself when the surface is flat.
 * @param {CanvasRenderingContext2D} ctx - The context.
 * @param {LensShape} shape - The outline.
 */
export function traceLensShape(ctx, shape) {
  const control = (from, to, through) => geometry.point(
    2 * through.x - (from.x + to.x) / 2,
    2 * through.y - (from.y + to.y) / 2
  );

  const front = control(shape.frontRim, shape.frontRim2, shape.frontVertex);
  const back = control(shape.backRim, shape.backRim2, shape.backVertex);

  ctx.beginPath();
  ctx.moveTo(shape.frontRim.x, shape.frontRim.y);
  ctx.quadraticCurveTo(front.x, front.y, shape.frontRim2.x, shape.frontRim2.y);
  ctx.lineTo(shape.backRim.x, shape.backRim.y);
  ctx.quadraticCurveTo(back.x, back.y, shape.backRim2.x, shape.backRim2.y);
  ctx.closePath();
}

/**
 * Draw an ideal lens as a piece of glass.
 * @param {CanvasRenderingContext2D} ctx - The context.
 * @param {CanvasRenderer} canvasRenderer - The renderer, for the length scale.
 * @param {Scene} scene - The scene, for the theme.
 * @param {LensShape} shape - The outline.
 * @param {number} refIndex - The refractive index the shape is drawn for, which sets how solid the
 * glass looks.
 * @param {boolean} isHovered - Whether to draw the lens highlighted.
 */
export function drawLensShape(ctx, canvasRenderer, scene, shape, refIndex, isHovered) {
  const ls = canvasRenderer.lengthScale;
  const glass = scene.theme.glass.color;

  traceLensShape(ctx, shape);

  ctx.globalAlpha = Math.min(0.5, Math.max(0.08, glassShadeAlpha(Math.max(1.01, refIndex), scene)));
  ctx.fillStyle = canvasRenderer.rgbaToCssColor({ r: glass.r, g: glass.g, b: glass.b, a: 1 });
  ctx.fill();

  ctx.globalAlpha = 1;
  ctx.lineWidth = 1 * ls;
  ctx.strokeStyle = isHovered ? scene.highlightColorCss : 'rgb(140,140,140)';
  ctx.stroke();
}
