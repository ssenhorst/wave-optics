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
 * @file `src/core/goals/goalTypes.js` defines the goal types that a scene can pose as an assignment.
 *
 * Each goal type is an object with:
 *
 * - `validate(goal)` returning an error string or null,
 * - `evaluate(goal, context)` returning a {@link GoalResult},
 * - `getTargets(goal)` returning the shapes to draw on the canvas as visual targets.
 *
 * The evaluation context contains the scene, the ray segments recorded by the simulator during the
 * last run, and helpers to look objects up by name.
 */

/**
 * @typedef {Object} RaySegment
 * @property {number} id - The identifier of the ray lineage the segment belongs to. Segments sharing
 * an id are successive parts of the same ray as it is reflected or refracted.
 * @property {number} x1 - The x coordinate of the start of the segment.
 * @property {number} y1 - The y coordinate of the start of the segment.
 * @property {number} x2 - The x coordinate of the end of the segment, or of a point along the ray if
 * the segment is unbounded.
 * @property {number} y2 - The y coordinate of the end of the segment.
 * @property {boolean} unbounded - Whether the segment extends to infinity beyond (x2, y2).
 * @property {number} brightness - The total brightness of the ray.
 * @property {number} depth - The number of interactions the ray has undergone.
 * @property {string|null} sourceName - The name of the light source the ray was emitted by, so that
 * a goal can single out one source in a scene that has several.
 */

/**
 * @typedef {Object} GoalResult
 * @property {boolean} satisfied - Whether the goal is met.
 * @property {number} progress - How close the student is, from 0 to 1. 1 means satisfied.
 * @property {string} detail - A short human-readable status, e.g. "4 of 6 rays on target".
 * @property {Array<Object>} [marks] - Extra shapes to draw as live feedback (e.g. the rays' actual
 * crossing point), each `{ type, ... }` in scene coordinates.
 */

import { imageQuality } from '../imaging/screenRenderer.js';
import { totalLensPower } from '../imaging/prescription.js';

const EPS = 1e-12;

/**
 * Squared distance from a point to a segment, treating unbounded segments as rays.
 * @param {RaySegment} seg - The segment.
 * @param {number} px - The x coordinate of the point.
 * @param {number} py - The y coordinate of the point.
 * @returns {number} The squared distance.
 */
function distanceSquaredToSegment(seg, px, py) {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < EPS) {
    return (px - seg.x1) * (px - seg.x1) + (py - seg.y1) * (py - seg.y1);
  }
  let t = ((px - seg.x1) * dx + (py - seg.y1) * dy) / lenSq;
  if (t < 0) t = 0;
  if (t > 1 && !seg.unbounded) t = 1;
  const cx = seg.x1 + t * dx;
  const cy = seg.y1 + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

/**
 * Perpendicular distance from a point to the infinite line a segment lies on. Convergence is a
 * property of the ray directions, so it is measured against the lines rather than the drawn extents.
 * @param {RaySegment} seg - The segment.
 * @param {number} px - The x coordinate of the point.
 * @param {number} py - The y coordinate of the point.
 * @returns {number} The distance.
 */
function distanceToLine(seg, px, py) {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const len = Math.hypot(dx, dy);
  if (len < EPS) return Math.hypot(px - seg.x1, py - seg.y1);
  return Math.abs((px - seg.x1) * dy - (py - seg.y1) * dx) / len;
}

/**
 * Whether a point lies ahead of a ray rather than behind it, which distinguishes a real focus from
 * the virtual one formed by the backward extensions.
 * @param {RaySegment} seg - The segment.
 * @param {number} px - The x coordinate of the point.
 * @param {number} py - The y coordinate of the point.
 * @returns {boolean} Whether the point is ahead of the segment's start.
 */
function isAhead(seg, px, py) {
  return (px - seg.x1) * (seg.x2 - seg.x1) + (py - seg.y1) * (seg.y2 - seg.y1) >= 0;
}

/**
 * Restrict the segments to those emitted by the source a goal names, if it names one.
 * @param {Array<RaySegment>} segments - The recorded segments.
 * @param {Object} goal - The goal definition.
 * @returns {Array<RaySegment>} The segments the goal is about.
 */
function segmentsOfGoal(segments, goal) {
  if (!goal.source) return segments;
  return segments.filter(seg => seg.sourceName === goal.source);
}

/**
 * The number of rays the relevant sources emitted, which is what "all the rays" means for a goal
 * that does not state a count.
 * @param {Array<RaySegment>} segments - The segments the goal is about.
 * @returns {number} The number of distinct rays leaving the sources.
 */
function emittedRayCount(segments) {
  const ids = new Set();
  for (const seg of segments) {
    if (seg.depth === 0) ids.add(seg.id);
  }
  return ids.size;
}

/**
 * The smallest distance from a point to any segment of each distinct ray.
 * @param {Array<RaySegment>} segments - The recorded segments.
 * @param {Point} point - The point.
 * @param {number} [minDepth=0] - Ignore segments whose depth is below this, so that a goal can
 * require the rays to have interacted with something before reaching the target.
 * @returns {Map<number, number>} A map from ray id to the smallest distance found for that ray.
 */
function perRayClosestDistance(segments, point, minDepth = 0) {
  const best = new Map();
  for (const seg of segments) {
    if (seg.depth < minDepth) continue;
    const d = Math.sqrt(distanceSquaredToSegment(seg, point.x, point.y));
    const prev = best.get(seg.id);
    if (prev === undefined || d < prev) best.set(seg.id, d);
  }
  return best;
}

/**
 * A smooth 0-to-1 score that reaches 1 when `value` is within `tolerance` of zero and decays for
 * larger values, so that the progress bar keeps moving even while the goal is far from met.
 * @param {number} value - The non-negative error.
 * @param {number} tolerance - The error at which the goal counts as met.
 * @returns {number} The score.
 */
function closenessScore(value, tolerance) {
  if (!isFinite(value)) return 0;
  if (value <= tolerance) return 1;
  return tolerance / value;
}

/**
 * Score a goal of the form "get N of these quantities below a tolerance". Quantities already below
 * it count in full; the rest contribute partial credit by how close they are, so the feedback keeps
 * moving while the student adjusts.
 * @param {Array<number>} sortedErrors - The errors of all candidates, ascending.
 * @param {number} tolerance - The error below which a candidate counts.
 * @param {number} required - How many candidates must be below the tolerance.
 * @param {number} power - The exponent applied to the partial credit. Use 1 when the errors span a
 * much wider range than the tolerance (angles), and 2 when being merely in the right area should
 * not read as nearly correct (distances).
 * @returns {number} The progress, from 0 to 1.
 */
function countingProgress(sortedErrors, tolerance, required, power) {
  if (required <= 0) return 1;
  let score = 0;
  for (let i = 0; i < Math.min(required, sortedErrors.length); i++) {
    const closeness = closenessScore(sortedErrors[i], tolerance);
    score += closeness >= 1 ? 1 : Math.pow(closeness, power) * 0.98;
  }
  return Math.min(1, score / required);
}

function requirePoint(goal, key) {
  const p = goal[key];
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') {
    return `goal of type '${goal.type}' requires a point '${key}' with numeric x and y`;
  }
  return null;
}

function findObjByName(context, name) {
  if (!name) return null;
  return context.scene.objs.find(obj => obj.name === name) || null;
}

/**
 * Require a given number of distinct rays to pass within a radius of a target point. This is the
 * basic "focus the light here" assignment.
 */
const raysThroughPoint = {
  validate(goal) {
    const err = requirePoint(goal, 'point');
    if (err) return err;
    if (goal.radius !== undefined && !(goal.radius > 0)) return 'radius must be a positive number';
    if (goal.count !== undefined && !(goal.count >= 0)) return 'count must be a non-negative number';
    return null;
  },

  getTargets(goal) {
    return [{ type: 'circle', x: goal.point.x, y: goal.point.y, r: goal.radius ?? 10 }];
  },

  evaluate(goal, context) {
    const radius = goal.radius ?? 10;
    const minDepth = goal.minDepth ?? 0;
    const relevant = segmentsOfGoal(context.segments, goal);
    const distances = perRayClosestDistance(relevant, goal.point, minDepth);
    const required = goal.count ?? emittedRayCount(relevant);

    const sorted = [...distances.values()].sort((a, b) => a - b);
    const onTarget = sorted.filter(d => d <= radius).length;

    if (required === 0) {
      return { satisfied: true, progress: 1, detail: 'no rays required' };
    }

    const progress = countingProgress(sorted, radius, required, 2);
    const satisfied = onTarget >= required;

    const marks = [];
    if (sorted.length > 0) {
      marks.push({ type: 'value', label: 'closest miss', value: sorted[Math.min(onTarget, sorted.length - 1)] });
    }

    return {
      satisfied,
      progress: satisfied ? 1 : progress,
      detail: `${onTarget} of ${required} rays within ${radius} units`,
      marks,
    };
  },
};

/**
 * Require the rays to avoid a region, e.g. "block the stray light from reaching the detector".
 */
const raysAvoidPoint = {
  validate(goal) {
    const err = requirePoint(goal, 'point');
    if (err) return err;
    if (goal.radius !== undefined && !(goal.radius > 0)) return 'radius must be a positive number';
    return null;
  },

  getTargets(goal) {
    return [{ type: 'circle', x: goal.point.x, y: goal.point.y, r: goal.radius ?? 10, forbidden: true }];
  },

  evaluate(goal, context) {
    const radius = goal.radius ?? 10;
    const distances = perRayClosestDistance(segmentsOfGoal(context.segments, goal), goal.point, goal.minDepth ?? 0);
    const offenders = [...distances.values()].filter(d => d <= radius).length;
    const total = distances.size || 1;
    return {
      satisfied: offenders === 0,
      progress: 1 - offenders / total,
      detail: offenders === 0 ? 'the region is clear' : `${offenders} ray(s) still reach the region`,
    };
  },
};

/**
 * Require the outgoing light to be collimated along a given direction, e.g. "turn the point source
 * into a parallel beam".
 */
const collimated = {
  validate(goal) {
    if (goal.angle === undefined && !goal.direction) {
      return "goal of type 'collimated' requires either 'angle' (degrees) or 'direction'";
    }
    if (goal.direction && (typeof goal.direction.x !== 'number' || typeof goal.direction.y !== 'number')) {
      return 'direction must have numeric x and y';
    }
    return null;
  },

  getTargets(goal) {
    return [];
  },

  evaluate(goal, context) {
    const toleranceDeg = goal.tolerance ?? 2;
    const targetAngle = goal.angle !== undefined
      ? goal.angle * Math.PI / 180
      : Math.atan2(goal.direction.y, goal.direction.x);

    // Only the last segment of each ray describes where the light finally goes. Segments that never
    // interacted with anything are excluded by default, so that light which simply misses the optics
    // does not count against the student.
    const minDepth = goal.minDepth ?? 1;
    const last = new Map();
    for (const seg of segmentsOfGoal(context.segments, goal)) {
      if (seg.depth < minDepth) continue;
      const prev = last.get(seg.id);
      if (prev === undefined || seg.depth >= prev.depth) last.set(seg.id, seg);
    }
    const outgoing = [...last.values()].filter(seg => seg.unbounded);
    if (outgoing.length === 0) {
      return { satisfied: false, progress: 0, detail: 'no light leaves the scene yet' };
    }

    const errors = outgoing.map(seg => {
      let diff = Math.atan2(seg.y2 - seg.y1, seg.x2 - seg.x1) - targetAngle;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      return Math.abs(diff * 180 / Math.PI);
    }).sort((a, b) => a - b);

    const aligned = errors.filter(e => e <= toleranceDeg).length;
    const worst = errors[errors.length - 1];
    const required = goal.count ?? outgoing.length;
    const satisfied = aligned >= required;

    return {
      satisfied,
      progress: satisfied ? 1 : countingProgress(errors, toleranceDeg, required, 1),
      detail: `${aligned} of ${required} rays within ${toleranceDeg}° (worst ${worst.toFixed(1)}°)`,
    };
  },
};

/**
 * Require the rays to converge to a common point, optionally at a given location. Unlike
 * `raysThroughPoint` this does not prescribe where the focus is, only how tight it is, which suits
 * tasks about aberration.
 */
const raysConverge = {
  validate(goal) {
    if (goal.point !== undefined) {
      const err = requirePoint(goal, 'point');
      if (err) return err;
    }
    if (goal.radius !== undefined && !(goal.radius > 0)) return 'radius must be a positive number';
    return null;
  },

  getTargets(goal) {
    if (!goal.point) return [];
    return [{ type: 'circle', x: goal.point.x, y: goal.point.y, r: goal.radius ?? 10 }];
  },

  evaluate(goal, context) {
    const radius = goal.radius ?? 10;
    const minDepth = goal.minDepth ?? 1;

    const last = new Map();
    for (const seg of segmentsOfGoal(context.segments, goal)) {
      if (seg.depth < minDepth) continue;
      const prev = last.get(seg.id);
      if (prev === undefined || seg.depth >= prev.depth) last.set(seg.id, seg);
    }
    const rays = [...last.values()];
    if (rays.length < 2) {
      return { satisfied: false, progress: 0, detail: 'not enough rays to define a focus' };
    }

    // The least-squares point minimising the distance to all ray lines has a closed form.
    let sxx = 0, sxy = 0, syy = 0, bx = 0, by = 0;
    for (const seg of rays) {
      const dx = seg.x2 - seg.x1;
      const dy = seg.y2 - seg.y1;
      const len = Math.hypot(dx, dy);
      if (len < EPS) continue;
      const nx = -dy / len;
      const ny = dx / len;
      const c = nx * seg.x1 + ny * seg.y1;
      sxx += nx * nx; sxy += nx * ny; syy += ny * ny;
      bx += nx * c; by += ny * c;
    }
    const det = sxx * syy - sxy * sxy;
    if (Math.abs(det) < EPS) {
      return { satisfied: false, progress: 0, detail: 'the rays are parallel, they never cross' };
    }
    const fx = (syy * bx - sxy * by) / det;
    const fy = (sxx * by - sxy * bx) / det;

    const focus = { x: fx, y: fy };
    const spread = Math.max(...rays.map(seg => distanceToLine(seg, fx, fy)));
    const isReal = rays.every(seg => isAhead(seg, fx, fy));
    const tightEnough = spread <= radius && isReal;

    let satisfied = tightEnough;
    let detail = isReal
      ? `spot size ${spread.toFixed(1)} units (need ${radius})`
      : 'the rays diverge, so the image is virtual';
    let progress = isReal ? closenessScore(spread, radius) : 0;

    if (goal.point) {
      const offset = Math.hypot(fx - goal.point.x, fy - goal.point.y);
      satisfied = tightEnough && offset <= radius;
      detail += `, ${offset.toFixed(1)} units off target`;
      progress = Math.min(progress, closenessScore(offset, radius));
    }

    return {
      satisfied,
      progress: satisfied ? 1 : progress,
      detail,
      marks: [{ type: 'point', x: focus.x, y: focus.y, label: 'focus' }],
    };
  },
};

/**
 * Require a detector in the scene to read a given power, e.g. "maximise the light collected".
 */
const detectorPower = {
  validate(goal) {
    if (!goal.detector) return "goal of type 'detectorPower' requires 'detector' (the name of a detector object)";
    if (goal.min === undefined && goal.target === undefined) {
      return "goal of type 'detectorPower' requires either 'min' or 'target'";
    }
    return null;
  },

  getTargets(goal) {
    return [];
  },

  evaluate(goal, context) {
    const detector = findObjByName(context, goal.detector);
    if (!detector) {
      return { satisfied: false, progress: 0, detail: `no object named "${goal.detector}"` };
    }
    const power = detector.power || 0;

    if (goal.target !== undefined) {
      const tolerance = goal.tolerance ?? Math.abs(goal.target) * 0.05;
      const error = Math.abs(power - goal.target);
      const satisfied = error <= tolerance;
      return {
        satisfied,
        progress: satisfied ? 1 : closenessScore(error, tolerance),
        detail: `power ${power.toFixed(3)} (target ${goal.target})`,
      };
    }

    const satisfied = power >= goal.min;
    return {
      satisfied,
      progress: satisfied ? 1 : Math.max(0, Math.min(1, power / goal.min)),
      detail: `power ${power.toFixed(3)} of ${goal.min} required`,
    };
  },
};

/**
 * Require a property of a named object to reach a given value, e.g. "set the focal length to 50" or
 * "place the lens at x = 300". Combined with a second goal this expresses tasks such as achieving a
 * prescribed magnification with a two-lens system.
 */
const objectProperty = {
  validate(goal) {
    if (!goal.object) return "goal of type 'objectProperty' requires 'object' (an object name)";
    if (!goal.property) return "goal of type 'objectProperty' requires 'property'";
    if (typeof goal.target !== 'number') return "goal of type 'objectProperty' requires a numeric 'target'";
    return null;
  },

  getTargets(goal) {
    return [];
  },

  evaluate(goal, context) {
    const obj = findObjByName(context, goal.object);
    if (!obj) {
      return { satisfied: false, progress: 0, detail: `no object named "${goal.object}"` };
    }
    let value = obj;
    for (const part of goal.property.split('.')) {
      value = value?.[part];
    }
    if (typeof value !== 'number') {
      return { satisfied: false, progress: 0, detail: `"${goal.property}" is not a number` };
    }
    const tolerance = goal.tolerance ?? Math.max(Math.abs(goal.target) * 0.02, 1e-6);
    const error = Math.abs(value - goal.target);
    const satisfied = error <= tolerance;
    return {
      satisfied,
      progress: satisfied ? 1 : closenessScore(error, tolerance),
      detail: `${goal.property} = ${value.toFixed(3)} (target ${goal.target} ± ${tolerance})`,
    };
  },
};


/**
 * Require the picture on an imaging screen to be sharp.
 *
 * The measure is the root-mean-square radius of the spot a point of the object is smeared into,
 * averaged over the field, which is the standard way an optical designer reports how good a system
 * is. It is reported as a bar rather than a score: the exercise is about understanding why splitting
 * the power helps, and a number out of a hundred invites a search for the number instead.
 */
const imageSharpness = {
  validate(goal) {
    if (!goal.screen) return "goal of type 'imageSharpness' requires 'screen' (the name of an ImageScreen)";
    if (typeof goal.max !== 'number') return "goal of type 'imageSharpness' requires a numeric 'max' (the blur that counts as sharp enough)";
    if (goal.reference !== undefined && typeof goal.reference !== 'number') {
      return "goal of type 'imageSharpness': 'reference' must be a number";
    }
    return null;
  },

  getTargets(goal) {
    return [];
  },

  evaluate(goal, context) {
    const screen = findObjByName(context, goal.screen);
    if (!screen) {
      return { satisfied: false, progress: 0, detail: `no object named "${goal.screen}"` };
    }
    const diagnostics = screen.diagnostics;
    if (!diagnostics || typeof diagnostics.rms !== 'number') {
      return { satisfied: false, progress: 0, detail: 'no image reaches the screen' };
    }

    const rms = diagnostics.rms;
    // The reference defaults to the blur the goal already calls sharp enough, so an author who has
    // chosen `max` does not have to choose a second, closely related number as well.
    const reference = goal.reference ?? goal.max;
    const satisfied = rms <= goal.max;

    return {
      satisfied,
      progress: satisfied ? 1 : imageQuality(rms, reference),
      detail: `blur ${rms.toFixed(2)} units across (need ${goal.max})`,
    };
  },
};

/**
 * Require the picture on an imaging screen to come out the right size.
 *
 * Without this, an exercise about sharpness has a cheat in it. A system with a lot of spherical
 * aberration has no one focal plane, and its tightest waist — the circle of least confusion — sits
 * well in front of where the picture is supposed to be, where the picture is also markedly smaller.
 * Sliding the screen there does improve the blur, but it answers a different question. Pinning the
 * size makes the student fix the optics instead of the framing.
 */
const imageSize = {
  validate(goal) {
    if (!goal.screen) return "goal of type 'imageSize' requires 'screen' (the name of an ImageScreen)";
    if (typeof goal.target !== 'number') {
      return "goal of type 'imageSize' requires a numeric 'target' (the magnification asked for)";
    }
    return null;
  },

  getTargets(goal) {
    return [];
  },

  evaluate(goal, context) {
    const screen = findObjByName(context, goal.screen);
    if (!screen) {
      return { satisfied: false, progress: 0, detail: `no object named "${goal.screen}"` };
    }
    const measured = screen.diagnostics?.imageMagnification;
    if (typeof measured !== 'number' || !(measured > 0)) {
      return { satisfied: false, progress: 0, detail: 'no image reaches the screen' };
    }

    const tolerance = goal.tolerance ?? Math.abs(goal.target) * 0.05;
    const error = Math.abs(measured - goal.target);
    const satisfied = error <= tolerance;
    return {
      satisfied,
      progress: satisfied ? 1 : closenessScore(error, tolerance),
      detail: `the picture is ${measured.toFixed(2)} times life size (target ${goal.target})`,
    };
  },
};

/**
 * Require the lenses of a system to add up to a given focusing power.
 *
 * This is the constraint that makes an exercise about splitting a lens an exercise rather than a
 * puzzle with a trivial answer: without it, the way to a sharp image is simply to stop bending the
 * light so much, which is true, useless, and not what is being taught. Holding the sum fixed leaves
 * only the question the exercise is about — how that bending should be distributed.
 */
const lensPowerSum = {
  validate(goal) {
    if (typeof goal.target !== 'number') return "goal of type 'lensPowerSum' requires a numeric 'target'";
    if (goal.lenses !== undefined && !Array.isArray(goal.lenses)) {
      return "goal of type 'lensPowerSum': 'lenses' must be an array of object names";
    }
    return null;
  },

  getTargets(goal) {
    return [];
  },

  evaluate(goal, context) {
    const power = totalLensPower(context.scene, goal.lenses || null);
    const tolerance = goal.tolerance ?? Math.abs(goal.target) * 0.02;
    const error = Math.abs(power - goal.target);
    const satisfied = error <= tolerance;

    // Focal lengths are what a student reads off the screen, so say it in those terms as well.
    const asFocalLength = power !== 0 ? (1 / power).toFixed(1) : 'infinite';
    return {
      satisfied,
      progress: satisfied ? 1 : closenessScore(error, tolerance),
      detail: `total power ${power.toFixed(5)} (a single lens of ${asFocalLength} units), target ${goal.target.toFixed(5)}`,
    };
  },
};

/**
 * The registry of goal types, keyed by the `type` field of a goal in the scene JSON.
 * @const {Object<string, Object>}
 */
export const GOAL_TYPES = {
  raysThroughPoint,
  raysAvoidPoint,
  raysConverge,
  collimated,
  detectorPower,
  objectProperty,
  imageSharpness,
  imageSize,
  lensPowerSum,
};
