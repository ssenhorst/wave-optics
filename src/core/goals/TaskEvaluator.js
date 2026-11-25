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
 * @file `src/core/goals/TaskEvaluator.js` turns the scene-level `task` property into live feedback.
 *
 * A task is a title, an optional description and hint, and a list of goals (see
 * {@link GOAL_TYPES}). After each simulation run the evaluator scores every goal from the ray
 * segments the simulator recorded, and reports both whether the goal is met and how close the
 * student is, so the UI can show a continuously moving progress indicator rather than a
 * pass/fail verdict only.
 */

import { GOAL_TYPES as RAY_GOAL_TYPES } from './goalTypes.js';
import { WAVE_GOAL_TYPES } from './waveGoalTypes.js';
import { buildWaveModel } from '../waveOptics/waveSceneModel.js';
import { computeModelFieldAt } from '../waveOptics/WaveFieldEngineCpu.js';

/**
 * Every goal type, whichever simulator the scene is for. Ray goals count ray segments and wave goals
 * measure the field, but a scene states them the same way and the evaluator scores them together.
 * @const {Object<string, Object>}
 */
export const GOAL_TYPES = { ...RAY_GOAL_TYPES, ...WAVE_GOAL_TYPES };

/**
 * Whether a scene is for the wave-optics simulator, which is true when it contains any of that
 * simulator's own objects.
 * @param {Scene} scene - The scene.
 * @returns {boolean} Whether the scene is a wave scene.
 */
export function isWaveScene(scene) {
  return !!scene && (scene.objs || []).some(obj => obj?.constructor?.type?.startsWith('Wave'));
}

/**
 * The keys accepted in the scene-level `task` property.
 * @const {Array<string>}
 */
const TASK_KEYS = ['title', 'description', 'hint', 'goals', 'requireAll', 'successMessage'];

/**
 * The keys accepted in every goal, in addition to the ones specific to its type.
 * @const {Array<string>}
 */
const COMMON_GOAL_KEYS = ['id', 'type', 'title', 'description', 'weight', 'showTarget', 'targetLabel'];

const TYPE_SPECIFIC_KEYS = ['point', 'radius', 'count', 'minDepth', 'angle', 'direction', 'tolerance',
  'detector', 'min', 'target', 'object', 'property', 'source',
  // Imaging goals, which read what the screen's renderer measured.
  'screen', 'reference', 'lenses',
  // Wave-optics goals, which probe the field along a line rather than counting rays.
  'line', 'samples', 'spacing', 'threshold', 'order', 'max', 'dip'];

/**
 * Validate a raw `task` object coming from JSON.
 * @param {Object} raw - The raw value.
 * @returns {string|null} An error message, or null if the value is valid.
 */
export function validateTask(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'task must be an object';

  for (const key in raw) {
    if (!TASK_KEYS.includes(key)) return `unknown task key '${key}'`;
  }
  if (raw.goals === undefined) return null;
  if (!Array.isArray(raw.goals)) return 'task.goals must be an array';

  const seenIds = new Set();
  for (let i = 0; i < raw.goals.length; i++) {
    const goal = raw.goals[i];
    if (!goal || typeof goal !== 'object' || Array.isArray(goal)) {
      return `task.goals[${i}] must be an object`;
    }
    const type = GOAL_TYPES[goal.type];
    if (!type) {
      return `task.goals[${i}] has unknown type '${goal.type}' (expected one of ${Object.keys(GOAL_TYPES).join(', ')})`;
    }
    for (const key in goal) {
      if (!COMMON_GOAL_KEYS.includes(key) && !TYPE_SPECIFIC_KEYS.includes(key)) {
        return `task.goals[${i}] has unknown key '${key}'`;
      }
    }
    if (goal.id !== undefined) {
      if (seenIds.has(goal.id)) return `task.goals[${i}] repeats the id '${goal.id}'`;
      seenIds.add(goal.id);
    }
    const err = type.validate(goal);
    if (err) return `task.goals[${i}]: ${err}`;
  }
  return null;
}

/**
 * @typedef {Object} TaskStatus
 * @property {boolean} hasTask - Whether the scene defines a task at all.
 * @property {boolean} complete - Whether the task as a whole is complete.
 * @property {number} progress - The weighted progress of the whole task, from 0 to 1.
 * @property {Array<Object>} goals - One entry per goal, each carrying the goal definition merged
 * with its {@link GoalResult}.
 */

/**
 * Evaluates the task of a scene against the result of the last simulation run.
 * @class
 */
class TaskEvaluator {
  /**
   * @param {Scene} scene - The scene carrying the task.
   */
  constructor(scene) {
    /** @property {Scene} scene - The scene carrying the task. */
    this.scene = scene;
  }

  /** @property {Object|null} task - The task definition of the scene, or null if there is none. */
  get task() {
    const task = this.scene.task;
    if (!task || !Array.isArray(task.goals) || task.goals.length === 0) return null;
    return task;
  }

  /**
   * Evaluate the wave field at a list of points, propagated through the scene's interfaces.
   *
   * The model is built at a small grid resolution: the grid only matters for what is drawn, while
   * what is sampled here is the field itself, whose accuracy comes from the source density instead.
   * @param {Array<Point>} points - Where to evaluate.
   * @returns {Float64Array|null} Interleaved real and imaginary parts, or null if this is not a wave
   * scene or the field could not be built.
   */
  sampleField(points) {
    if (!isWaveScene(this.scene)) return null;
    try {
      if (!this.waveModel) {
        this.waveModel = buildWaveModel(this.scene, { resolution: 64 });
      }
      return computeModelFieldAt(this.waveModel, points);
    } catch (e) {
      return null;
    }
  }

  /**
   * The shapes that should be drawn on the canvas so the student can see what to aim at.
   * @returns {Array<Object>} The target shapes, each annotated with the index of its goal.
   */
  getTargets() {
    const task = this.task;
    if (!task) return [];
    const targets = [];
    task.goals.forEach((goal, index) => {
      if (goal.showTarget === false) return;
      const type = GOAL_TYPES[goal.type];
      if (!type) return;
      for (const shape of type.getTargets(goal)) {
        targets.push({ ...shape, goalIndex: index, label: goal.targetLabel });
      }
    });
    return targets;
  }

  /**
   * Score every goal against the recorded ray segments.
   * @param {Array<RaySegment>} segments - The segments recorded by the simulator during the last run.
   * @param {number} rayCount - The number of rays the sources emitted, used as the default required
   * count for goals that do not state one.
   * @returns {TaskStatus} The status of the task.
   */
  evaluate(segments, rayCount) {
    const task = this.task;
    if (!task) {
      return { hasTask: false, complete: false, progress: 0, goals: [] };
    }

    // The scene may have changed since the last run, so any cached field model is stale.
    this.waveModel = null;

    const context = {
      scene: this.scene,
      segments: segments || [],
      rayCount,
      // Built once per evaluation and only if a goal actually asks for it: propagating the field
      // through the subspaces is the expensive part, and a ray scene never needs it.
      sampleField: (points) => this.sampleField(points),
    };

    let totalWeight = 0;
    let weightedProgress = 0;
    let allSatisfied = true;
    let anySatisfied = false;

    const goals = task.goals.map((goal, index) => {
      const type = GOAL_TYPES[goal.type];
      let result;
      try {
        result = type.evaluate(goal, context);
      } catch (e) {
        result = { satisfied: false, progress: 0, detail: `could not be evaluated: ${e.message}` };
      }
      const weight = goal.weight ?? 1;
      totalWeight += weight;
      weightedProgress += weight * Math.max(0, Math.min(1, result.progress));
      if (result.satisfied) anySatisfied = true; else allSatisfied = false;

      return {
        id: goal.id ?? `goal-${index}`,
        index,
        type: goal.type,
        title: goal.title || defaultGoalTitle(goal),
        description: goal.description || '',
        ...result,
      };
    });

    const requireAll = task.requireAll !== false;
    return {
      hasTask: true,
      complete: requireAll ? allSatisfied : anySatisfied,
      progress: totalWeight > 0 ? weightedProgress / totalWeight : 0,
      goals,
    };
  }
}

/**
 * A readable fallback title for a goal that does not state one.
 * @param {Object} goal - The goal definition.
 * @returns {string} The title.
 */
function defaultGoalTitle(goal) {
  switch (goal.type) {
    case 'raysThroughPoint': return 'Send the rays through the target';
    case 'raysAvoidPoint': return 'Keep the rays out of the marked region';
    case 'raysConverge': return 'Bring the rays to a sharp focus';
    case 'collimated': return 'Make the outgoing light parallel';
    case 'detectorPower': return 'Reach the required power on the detector';
    case 'objectProperty': return `Set ${goal.property} to ${goal.target}`;
    case 'waveIntensityPeak': return 'Put the brightest point on the target';
    case 'waveFringeSpacing': return `Make the fringes ${goal.spacing} units apart`;
    case 'waveFringeContrast': return 'Make the fringes stand out clearly';
    case 'waveSpotSize': return 'Make the focus small enough';
    case 'waveResolvedPeaks': return `Resolve ${goal.count} separate peaks`;
    default: return goal.type;
  }
}

export default TaskEvaluator;
