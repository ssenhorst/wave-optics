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

import CanvasRenderer from '../CanvasRenderer.js';
import WaveFieldEngineWebGL2 from './WaveFieldEngineWebGL2.js';
import { buildWaveModel, resolveWaveSettings, isTimeDependent } from './waveSceneModel.js';
import { AdaptiveResolution } from './adaptiveResolution.js';

/**
 * How long after the last edit the field is recomputed at full resolution.
 * Long enough to coalesce a drag, short enough not to feel laggy.
 */
const REFINE_DELAY_MS = 150;

/**
 * Fallback window for deciding that updates are part of an interaction, used
 * only when there is no editor to ask.
 */
const INTERACTION_WINDOW_MS = 200;

/**
 * The wave-optics counterpart of {@link Simulator}: it presents the same
 * interface to {@link Editor} (`updateSimulation`, `dpr`, the event emitter)
 * but replaces ray tracing with a summation of point-source fields.
 *
 * Responsibilities are split the same way as in the ray simulator. The scene
 * objects draw themselves onto the 2D canvas layers; this class draws the grid,
 * drives the field engine, and owns the animation clock.
 *
 * @class
 */
class WaveSimulator {
  /**
   * @param {Object} options
   * @param {Scene} options.scene
   * @param {WebGL2RenderingContext} options.gl - Context of the field canvas.
   * @param {CanvasRenderingContext2D} options.ctxBelowLight
   * @param {CanvasRenderingContext2D} options.ctxAboveLight
   * @param {CanvasRenderingContext2D} options.ctxGrid
   */
  constructor({ scene, gl, ctxBelowLight, ctxAboveLight, ctxGrid }) {
    /** @property {Scene} scene - The scene being simulated. */
    this.scene = scene;
    this.scene.simulator = this;

    this.gl = gl;
    this.ctxBelowLight = ctxBelowLight;
    this.ctxAboveLight = ctxAboveLight;
    this.ctxGrid = ctxGrid;

    /** @property {number} dpr - Device pixel ratio of the canvas layers. */
    this.dpr = 1;

    /**
     * @property {WebGLRenderingContext|null} glMain - Always null. The ray
     * simulator exposes this for its image-export path; the wave app does not
     * use that path, and leaving it null makes the check there fail cleanly.
     */
    this.glMain = null;

    /** @property {Object} eventListeners - Registered event callbacks. */
    this.eventListeners = {};

    /** @property {number} time - Animation clock, in optical cycles. */
    this.time = 0;

    /** @property {boolean} isAnimating - Whether the animation loop is running. */
    this.isAnimating = false;

    /** @property {number} animationSpeed - Optical cycles per second of wall time. */
    this.animationSpeed = 0.5;

    /** @property {Object|null} lastModel - The model built by the last field computation. */
    this.lastModel = null;

    /** @property {number} lastComputeMs - Duration of the last field computation. */
    this.lastComputeMs = 0;

    /** @property {string|null} error - The current error message, if any. */
    this.error = null;

    this.engine = null;
    this.engineError = null;
    this.referenceAmplitude = 0;
    this.lastLightUpdateTime = -Infinity;
    this.refineTimerId = -1;

    /**
     * @property {AdaptiveResolution} adaptive - Tracks what this machine has
     * managed within each time budget, so the grid can be sized from
     * measurement rather than a fixed guess.
     */
    this.adaptive = new AdaptiveResolution();

    /** @property {number} currentResolution - The resolution last computed at. */
    this.currentResolution = 0;

    /**
     * @property {number} fieldSerial - Bumped whenever the field changes.
     * Measurement objects key their cached results on it, so a redraw that
     * changes nothing — a hover, a selection — costs them nothing.
     */
    this.fieldSerial = 0;

    /**
     * @property {Float32Array|null} fieldReadback - The last field brought back
     * from the GPU, or null if nothing has asked for one.
     */
    this.fieldReadback = null;

    /**
     * @property {boolean} isTimeMode - Whether the last model has sources with
     * a time dependence, so that the field shown is the one at {@link time}
     * rather than the time-harmonic one.
     */
    this.isTimeMode = false;

    /** Whether the colour scale still needs reading back for this change. */
    this.needsStats = true;
    this.animationFrameId = -1;
    this.animationLastTime = 0;

    try {
      this.engine = new WaveFieldEngineWebGL2(gl);
    } catch (e) {
      this.engineError = e.message;
      this.error = e.message;
    }
  }

  /**
   * Register an event listener.
   * @param {string} eventName
   * @param {function} callback
   */
  on(eventName, callback) {
    if (!this.eventListeners[eventName]) {
      this.eventListeners[eventName] = [];
    }
    this.eventListeners[eventName].push(callback);
  }

  /**
   * Emit an event to its listeners.
   * @param {string} eventName
   * @param {*} data
   */
  emit(eventName, data) {
    for (const callback of this.eventListeners[eventName] ?? []) {
      callback(data);
    }
  }

  /**
   * Redraw the scene, and recompute the field unless told to skip it.
   *
   * The signature matches {@link Simulator#updateSimulation} because
   * {@link Editor} calls it directly.
   *
   * @param {boolean} [skipLight=false] - Skip recomputing the field.
   * @param {boolean} [skipGrid=false] - Skip redrawing the background grid.
   * @param {boolean} [forceRedraw=false] - Unused; accepted for interface parity.
   */
  updateSimulation(skipLight = false, skipGrid = false, forceRedraw = false) {
    this.emit('update', { skipLight, skipGrid, forceRedraw });

    this.drawGrid(skipGrid);
    this.drawObjects();

    if (!skipLight) {
      this.scheduleFieldUpdate();
    }

    this.emit('requestUpdateErrorAndWarning');
  }

  /**
   * Recompute the field, then climb towards the target resolution.
   *
   * The starting point is whatever this machine has already proved it can
   * manage inside the relevant time budget, which is tracked separately for
   * drags and for settled redraws. After the user stops, the refinement steps
   * up one rung at a time for as long as each step stays cheap enough to
   * justify the next.
   * @private
   */
  scheduleFieldUpdate() {
    if (!this.engine) return;

    const settings = resolveWaveSettings(this.scene);
    // A playing time-dependent scene computes every frame, so an edit made
    // while it plays is held to the interactive budget too.
    const isInteracting = this.isInteracting() || (this.isTimeMode && this.isAnimating);

    if (this.refineTimerId !== -1) {
      clearTimeout(this.refineTimerId);
      this.refineTimerId = -1;
    }

    // The colour scale is read back once per change, on the first pass, and
    // reused as the picture sharpens. That keeps the colours from shifting
    // under the refinement, and keeps the readback off the largest grids.
    this.needsStats = true;

    const target = settings.targetResolution;
    // The resolution can only be chosen once the source count is known, and
    // the source count is only known once the scene has been built — so the
    // choice is made from inside buildWaveModel via this callback, rather than
    // computed up front. Picking it up front is exactly what caused a scene
    // change to try whatever resolution a *previous, unrelated* scene had
    // proven safe, regardless of how many more sources the new one has.
    this.computeField(
      (sourceCount) => this.adaptive.chooseInitial(sourceCount, target, isInteracting),
      isInteracting
    );
    this.render();
    // Measurements read the field they annotate, so they can only be drawn once
    // it exists. The object layer was drawn before the field was computed, so
    // it is drawn again now rather than showing the previous answer.
    if (this.needsFieldReadback()) this.drawObjects();
    this.scheduleRefine(target);
  }

  /**
   * Whether anything in the scene wants the computed samples back.
   *
   * Reading the framebuffer costs a pipeline stall and a transfer of the whole
   * grid, so it is worth asking rather than doing it unconditionally.
   * @returns {boolean}
   */
  needsFieldReadback() {
    return (this.scene.objs ?? []).some((obj) => obj.readsField?.());
  }

  /**
   * Whether the user is in the middle of a gesture.
   *
   * The editor is asked directly rather than inferred from how closely updates
   * arrive. On a machine where one redraw already takes longer than the
   * inference window, consecutive mouse moves would each look like a fresh
   * change, and the drag would never get the responsive budget it needs — which
   * is exactly the case where it matters most.
   *
   * @returns {boolean}
   * @private
   */
  isInteracting() {
    const editor = this.scene.editor;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();

    if (editor) {
      // -1 means nothing is being dragged; anything else is an object, the
      // scene being panned, or the observer.
      const dragging = editor.draggingObjIndex !== -1 || Boolean(editor.isConstructing);
      this.lastLightUpdateTime = now;
      return dragging;
    }

    const recent = now - this.lastLightUpdateTime < INTERACTION_WINDOW_MS;
    this.lastLightUpdateTime = now;
    return recent;
  }

  /**
   * Queue the next step of the resolution climb.
   * @param {number} target
   * @private
   */
  scheduleRefine(target) {
    if (this.refineTimerId !== -1) {
      clearTimeout(this.refineTimerId);
      this.refineTimerId = -1;
    }
    // A time-dependent scene recomputes every frame while it plays, so it stays
    // at the resolution that fits a frame; the climb resumes when it stops.
    if (this.isTimeMode && this.isAnimating) return;
    const next = this.adaptive.nextStep(this.currentResolution, target, this.lastComputeMs);
    if (next === null) return;

    this.refineTimerId = setTimeout(() => {
      this.refineTimerId = -1;
      // A refinement step already has a real measurement for this scene's
      // source count at the current resolution (nextStep only offers a rung
      // once that measurement came in comfortably under budget), so there is
      // no chicken-and-egg problem here: the target resolution is just a
      // constant.
      this.computeField(next, false);
      this.render();
      if (this.needsFieldReadback()) this.drawObjects();
      this.scheduleRefine(target);
    }, REFINE_DELAY_MS);
  }

  /**
   * Compute the field at a given grid resolution and update the colour scale.
   * @param {number|function(number): number} resolutionOrResolver - Either a
   *   fixed resolution, or a function from the scene's source count to the
   *   resolution to use — needed whenever the choice depends on the source
   *   count, since that is only known once the scene has been built.
   * @param {boolean} [isInteracting=false] - Which time budget applies.
   * @private
   */
  computeField(resolutionOrResolver, isInteracting = false) {
    if (!this.engine) return;

    const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let resolution = typeof resolutionOrResolver === 'number' ? resolutionOrResolver : 0;
    const model = buildWaveModel(this.scene, {
      resolveResolution: typeof resolutionOrResolver === 'function'
        ? (sourceCount) => (resolution = resolutionOrResolver(sourceCount))
        : undefined,
      resolution: typeof resolutionOrResolver === 'number' ? resolutionOrResolver : undefined,
    });
    this.lastModel = model;
    this.currentResolution = resolution;

    try {
      this.engine.computeField(model);

      const settled = this.needsStats && !isInteracting;
      if (settled || this.referenceAmplitude === 0) {
        const stats = this.engine.readFieldStats(model.settings.scalePercentile);
        this.referenceAmplitude = stats.referenceAmplitude;
        this.needsStats = false;
        this.fieldReadback = this.engine.readbackBuffer;
      } else if (this.needsFieldReadback()) {
        // A measurement reads the field itself, so it needs the samples back
        // even on the passes the colour scale does not.
        this.fieldReadback = this.engine.readField();
      }
      // The colour scale and the measurements above come from the time-harmonic
      // field, which every envelope is a modulation of. That keeps the scale
      // steady while a pulse crosses the view instead of rescaling every frame.
      this.isTimeMode = isTimeDependent(model);
      if (this.isTimeMode) this.engine.computeFieldAtTime(model, this.time);

      this.fieldSerial++;
      this.error = null;
    } catch (e) {
      this.error = e.message;
    }

    const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.lastComputeMs = endTime - startTime;
    this.adaptive.record(resolution, model.diagnostics.sourceCount, this.lastComputeMs, isInteracting);

    this.emit('fieldComputed', {
      diagnostics: model.diagnostics,
      warnings: model.warnings,
      resolution,
      isInteracting,
      gridWidth: model.grid.width,
      gridHeight: model.grid.height,
      computeMs: this.lastComputeMs,
      referenceAmplitude: this.referenceAmplitude,
    });
  }

  /**
   * Colour the cached field onto the canvas. This is the only work an
   * animation frame does.
   */
  render() {
    if (!this.engine) return;
    const settings = resolveWaveSettings(this.scene);

    if (!this.lastModel || this.lastModel.diagnostics.sourceCount === 0) {
      this.engine.clear();
      return;
    }

    this.engine.render({
      view: settings.view,
      colormap: settings.view === 'field'
        ? settings.fieldColormap
        : settings.intensityColormap,
      chroma: settings.phaseChroma,
      referenceAmplitude: this.referenceAmplitude,
      upperCutoff: settings.upperCutoff,
      lowerCutoff: settings.lowerCutoff,
      phase: this.time * Math.PI * 2,
      logScale: settings.logScale,
      dynamicRange: settings.dynamicRange,
    });
  }

  /**
   * Draw the background grid, mirroring the ray simulator's grid so the two
   * apps look and snap the same.
   * @param {boolean} skipGrid
   * @private
   */
  drawGrid(skipGrid) {
    if (skipGrid || !this.ctxGrid) return;

    const ctx = this.ctxGrid;
    const scale = this.scene.scale * this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (!this.scene.showGrid) return;

    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    let dashPattern = this.scene.theme.grid.dash.map((value) => value * this.scene.lengthScale);
    const dashPeriod = dashPattern.reduce((a, b) => a + b, 0);
    if (dashPeriod * this.scene.scale <= 2) dashPattern = [];

    const color = this.scene.theme.grid.color;
    ctx.strokeStyle = `rgba(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)},${color.a})`;
    ctx.lineWidth = this.scene.theme.grid.width * this.scene.lengthScale;
    ctx.setLineDash(dashPattern);

    const gridSize = this.scene.gridSize;
    const viewWidth = ctx.canvas.width / scale;
    const viewHeight = ctx.canvas.height / scale;

    ctx.beginPath();
    for (let x = this.scene.origin.x / this.scene.scale % gridSize; x <= viewWidth; x += gridSize) {
      ctx.moveTo(x, this.scene.origin.y / this.scene.scale % gridSize - gridSize);
      ctx.lineTo(x, viewHeight);
    }
    ctx.stroke();

    ctx.beginPath();
    for (let y = this.scene.origin.y / this.scene.scale % gridSize; y <= viewHeight; y += gridSize) {
      ctx.moveTo(this.scene.origin.x / this.scene.scale % gridSize - gridSize, y);
      ctx.lineTo(viewWidth, y);
    }
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.restore();
  }

  /**
   * Draw the scene objects onto the 2D layers.
   *
   * Wave objects draw themselves on the "above light" layer, since the field
   * is an opaque image covering the whole canvas.
   * @private
   */
  drawObjects() {
    if (!this.ctxBelowLight || !this.ctxAboveLight) return;

    const origin = { x: this.scene.origin.x * this.dpr, y: this.scene.origin.y * this.dpr };
    const scale = this.scene.scale * this.dpr;

    const below = new CanvasRenderer(
      this.ctxBelowLight, origin, scale, this.scene.lengthScale, this.scene.backgroundImage
    );
    const above = new CanvasRenderer(
      this.ctxAboveLight, origin, scale, this.scene.lengthScale
    );

    const order = this.scene.objs
      .map((obj, index) => ({ index, zIndex: obj.getZIndex() }))
      .sort((a, b) => a.zIndex - b.zIndex);

    for (const { index } of order) {
      const isHighlighted = this.scene.editor
        ? this.scene.editor.isObjHighlighted(index)
        : false;
      this.scene.objs[index].draw(below, false, isHighlighted);
    }
    for (const { index } of order) {
      const isHighlighted = this.scene.editor
        ? this.scene.editor.isObjHighlighted(index)
        : false;
      this.scene.objs[index].draw(above, true, isHighlighted);
    }

    this.drawExternalHandles(above);
  }

  /**
   * Draw the handles the application owns, such as the targets of a task's goals while the task is
   * being designed. Drawn above the objects so they can always be found and grabbed.
   * @param {CanvasRenderer} canvasRenderer - The renderer for the layer above the field.
   */
  drawExternalHandles(canvasRenderer) {
    const handles = this.scene.editor?.externalHandles;
    if (!canvasRenderer?.ctx || !handles?.length) return;

    const ctx = canvasRenderer.ctx;
    const scale = this.scene.scale || 1;

    ctx.save();
    ctx.globalAlpha = 1;
    for (const handle of handles) {
      const p = handle?.point;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;

      if (handle.lineTo && Number.isFinite(handle.lineTo.x)) {
        ctx.strokeStyle = 'rgb(240,180,41)';
        ctx.lineWidth = 1 / scale;
        ctx.setLineDash([5 / scale, 4 / scale]);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(handle.lineTo.x, handle.lineTo.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (handle.radius > 0) {
        ctx.strokeStyle = 'rgb(240,180,41)';
        ctx.lineWidth = 1 / scale;
        ctx.setLineDash([4 / scale, 3 / scale]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, handle.radius, 0, Math.PI * 2, false);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.fillStyle = 'rgb(240,180,41)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4 / scale, 0, Math.PI * 2, false);
      ctx.fill();

      if (handle.label) {
        ctx.font = `${12 / scale}px Arial`;
        ctx.textAlign = 'center';
        ctx.fillText(handle.label, p.x, p.y - 9 / scale);
      }
    }
    ctx.restore();
  }

  /**
   * Start animating the instantaneous-field view.
   *
   * For a time-harmonic scene only {@link WaveSimulator#render} runs per
   * frame: the complex field is time-independent and stays cached in its
   * texture, so the frame rate does not depend on how many sources there are.
   * A scene with time-dependent sources computes the field at each frame's
   * instant, which costs about as much as one time-harmonic computation.
   */
  startAnimation() {
    if (this.isAnimating || typeof requestAnimationFrame === 'undefined') return;
    this.isAnimating = true;
    this.animationLastTime = performance.now();

    if (this.isTimeMode) {
      // Every frame is a full field pass, so drop to the resolution that fits
      // the interactive budget rather than keep the settled one.
      const target = resolveWaveSettings(this.scene).targetResolution;
      this.computeField(
        (sourceCount) => this.adaptive.chooseInitial(sourceCount, target, true), true
      );
      this.scheduleRefine(target);
    }

    const step = () => {
      if (!this.isAnimating) return;
      const now = performance.now();
      const elapsed = (now - this.animationLastTime) / 1000;
      this.animationLastTime = now;
      this.time += elapsed * this.animationSpeed;
      this.computeFrame();
      this.render();
      this.emit('timeChange', { time: this.time });
      this.animationFrameId = requestAnimationFrame(step);
    };
    this.animationFrameId = requestAnimationFrame(step);
    this.emit('animationChange', { isAnimating: true });
  }

  /** Stop the animation loop. */
  stopAnimation() {
    if (!this.isAnimating) return;
    this.isAnimating = false;
    if (this.animationFrameId !== -1) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = -1;
    }
    // Paused on a frame, the field can afford the settled resolution again.
    if (this.isTimeMode) this.scheduleFieldUpdate();
    this.emit('animationChange', { isAnimating: false });
  }

  /**
   * Bring the field texture to the current time, for a time-dependent scene.
   * A time-harmonic field needs nothing: its texture holds it for all time.
   * @private
   */
  computeFrame() {
    if (!this.isTimeMode || !this.engine || !this.lastModel) return;
    try {
      this.engine.computeFieldAtTime(this.lastModel, this.time);
    } catch (e) {
      this.error = e.message;
    }
  }

  /**
   * Set the animation clock and redraw.
   * @param {number} time - In optical cycles.
   */
  setTime(time) {
    this.time = time;
    this.computeFrame();
    this.render();
    this.emit('timeChange', { time: this.time });
  }

  /** The current error message, for the status area. */
  getError() {
    return this.error;
  }

  /** Release the GPU resources and stop all timers. */
  destroy() {
    this.stopAnimation();
    if (this.refineTimerId !== -1) {
      clearTimeout(this.refineTimerId);
      this.refineTimerId = -1;
    }
    this.engine?.destroy();
    this.engine = null;
    this.eventListeners = {};
  }
}

export default WaveSimulator;
