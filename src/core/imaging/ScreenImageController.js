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
 * @file `src/core/imaging/ScreenImageController.js` keeps every {@link ImageScreen} in a scene
 * showing the picture the system currently forms on it.
 *
 * Two things make this worth having rather than rendering from the drawing code. The first is that
 * a render is expensive enough to be worth not repeating: the controller fingerprints the optical
 * geometry and skips the work entirely when nothing that matters has moved, which is most frames.
 * The second is that there are two renders, not one — a coarse one while the student is dragging
 * something, so the picture keeps up with their hand, and a fine one a moment after they stop. A
 * student sliding the screen through focus wants to see the blur change immediately; the detail can
 * arrive once they have found roughly the right place.
 */

import { readPrescription } from './prescription.js';
import { paraxialImage } from './sequentialTrace.js';
import {
  traceSpotField, renderScreenImage, imageQuality, RENDER_QUALITY, GPU_RENDER_QUALITY,
} from './screenRenderer.js';
import WebglScreenRenderer from './webglScreenRenderer.js';

/** How long after the last change the full-quality render is run, in milliseconds. */
const SETTLE_MS = 140;

/**
 * A monotonic clock, where there is one.
 * @returns {number} The time in milliseconds.
 */
function now() {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}

/**
 * Keeps the screens in a scene up to date.
 * @class
 */
class ScreenImageController {
  /**
   * @param {Scene} scene - The scene.
   * @param {Object} [options] - Options.
   * @param {function():void} [options.onRendered] - Called after a render, so the caller can redraw
   * and rescore the task.
   */
  constructor(scene, options = {}) {
    /** @property {Scene} scene - The scene. */
    this.scene = scene;
    /** @property {function():void} onRendered - The callback after each render. */
    this.onRendered = options.onRendered || (() => {});

    /** @property {Object<number, Object>} textures - The object's pixels, by the size asked for. */
    this.textures = {};
    /** @property {HTMLImageElement|null} sourceImage - The picture the texture came from. */
    this.sourceImage = null;

    /** @property {Object<string, string>} fingerprints - The last state each screen was rendered for. */
    this.fingerprints = {};
    /** @property {Object<string, string>} qualities - Which preset each screen currently holds. */
    this.qualities = {};

    this.settleTimer = null;
    this.destroyed = false;

    /**
     * @property {WebglScreenRenderer|null} gpu - The GPU renderer, or null where the browser cannot
     * provide one and the CPU has to do it.
     */
    this.gpu = options.gpu === false ? null : WebglScreenRenderer.create();

    /** @property {Object<string, HTMLCanvasElement>} canvases - One picture surface per screen. */
    this.canvases = {};

    /** @property {Object|null} timings - What the last render cost, in milliseconds. */
    this.timings = null;
  }

  /**
   * The presets to use, which differ by an order of magnitude between the two renderers: the GPU
   * can afford a pupil sampled finely enough that the blur is smooth, where the CPU cannot.
   * @returns {Object} The preset table.
   */
  get presets() {
    return this.gpu ? GPU_RENDER_QUALITY : RENDER_QUALITY;
  }

  /**
   * The surface a screen's picture is drawn on.
   *
   * The GPU draws every screen into one canvas of its own, so the picture has to be copied out
   * before the next render overwrites it.
   * @param {string} key - Which screen.
   * @param {number} size - The side in pixels.
   * @returns {HTMLCanvasElement} The canvas.
   */
  canvasFor(key, size) {
    let canvas = this.canvases[key];
    if (!canvas) {
      canvas = document.createElement('canvas');
      this.canvases[key] = canvas;
    }
    if (canvas.width !== size || canvas.height !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    return canvas;
  }

  /**
   * Give the controller the picture that stands for the object.
   * @param {HTMLImageElement} image - The loaded picture.
   */
  setObjectPicture(image) {
    if (this.sourceImage === image) return;
    this.sourceImage = image;
    this.textures = {};
    this.fingerprints = {};
  }

  /**
   * Extract the object's pixels at the resolution a preset asks for.
   *
   * The picture is redrawn at the resolution it is sampled at rather than scaled down afterwards,
   * so the object the renderer sees is as sharp as the canvas can make it and every blur in the
   * result is the optics' doing.
   * @param {number} size - The height in pixels to sample the picture at.
   * @returns {Object|null} The texture, or null if the picture is not loaded yet.
   */
  getTexture(size) {
    const image = this.sourceImage;
    if (!image || !image.complete || !image.naturalWidth) return null;
    // Both presets' textures are kept, because dragging alternates between them and rasterising
    // the picture again on every switch costs more than holding two small buffers.
    if (this.textures[size]) return this.textures[size];

    const height = size;
    const width = Math.max(1, Math.round(size * image.naturalWidth / image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    const pixels = ctx.getImageData(0, 0, width, height);
    this.textures[size] = { data: pixels.data, width, height };
    return this.textures[size];
  }

  /**
   * Where the object is: the plane it stands in, its half height, and how far its centre is off the
   * axis. It is located by the two light sources the scene's `illustration` names, which are the
   * same two points the ray diagram draws the object between.
   * @param {number} axisY - The optical axis.
   * @returns {{z: number, halfHeight: number, offsetY: number}|null} The object, or null if the
   * scene does not say where it is.
   */
  getObject(axisY) {
    const config = this.scene.illustration;
    if (!config) return null;

    const find = name => (this.scene.objs || []).find(obj => obj.name === name);
    const top = find(config.top);
    const bottom = find(config.bottom);
    if (!top?.p1 || !bottom?.p1) return null;

    const halfHeight = Math.abs(top.p1.y - bottom.p1.y) / 2;
    if (!(halfHeight > 0)) return null;

    return {
      z: (top.p1.x + bottom.p1.x) / 2,
      halfHeight,
      offsetY: (top.p1.y + bottom.p1.y) / 2 - axisY,
    };
  }

  /**
   * A short string that changes exactly when the picture would change.
   * @param {Object} screen - The screen object.
   * @param {Object} prescription - The prescription in front of it.
   * @param {Object} object - The object's placement.
   * @returns {string} The fingerprint.
   */
  fingerprint(screen, prescription, object) {
    const parts = [
      screen.p1.x, screen.p1.y, screen.p2.x, screen.p2.y, screen.panelScale,
      object.z, object.halfHeight, object.offsetY,
    ];
    for (const surface of prescription.surfaces) {
      parts.push(surface.kind, surface.z, surface.radius ?? surface.focalLength ?? 0,
        surface.semiAperture, surface.nAfter);
    }
    return parts.map(p => (typeof p === 'number' ? p.toFixed(4) : p)).join('|');
  }

  /**
   * Render every screen in the scene whose picture is out of date.
   * @param {Object} [options] - Options.
   * @param {boolean} [options.preview=false] - Whether to use the coarse preset, and to schedule the
   * fine one for when things settle.
   * @returns {boolean} Whether anything was rendered.
   */
  update(options = {}) {
    if (this.destroyed) return false;
    const preview = !!options.preview;
    const preset = preview ? this.presets.preview : this.presets.full;

    const screens = (this.scene.objs || [])
      .filter(obj => obj?.constructor?.type === 'ImageScreen');
    if (!screens.length) return false;

    let rendered = false;

    for (let i = 0; i < screens.length; i++) {
      const screen = screens[i];
      const geometry = screen.getGeometry();
      if (!geometry) continue;

      const axisY = geometry.centre.y;
      const object = this.getObject(axisY);
      if (!object) continue;

      const prescription = readPrescription(this.scene, axisY, {
        fromZ: object.z,
        toZ: geometry.z,
      });
      if (!prescription.surfaces.length) {
        screen.setPicture(null, { warnings: prescription.warnings, reason: 'noOptics' });
        continue;
      }

      const key = `${i}:${screen.name || ''}`;
      const stamp = this.fingerprint(screen, prescription, object);
      if (this.fingerprints[key] === stamp) {
        // Nothing has moved. The only render still worth doing is the fine one that replaces a
        // preview; asking for a preview over a picture that is already fine would throw detail
        // away and make the picture flicker between qualities as the mouse moves.
        const held = this.qualities[key];
        if (held === 'full' || preview) continue;
      }

      const texture = this.getTexture(preset.objectSize);
      if (!texture) continue;

      const result = this.renderOne({
        screen, geometry, object, prescription, texture, preset, key,
      });
      if (!result) continue;

      this.fingerprints[key] = stamp;
      this.qualities[key] = preview ? 'preview' : 'full';
      rendered = true;
    }

    if (rendered) this.onRendered();

    if (preview) this.scheduleSettle();
    return rendered;
  }

  /**
   * Render one screen.
   * @param {Object} params - Everything the render needs.
   * @returns {Object|null} What was measured, or null if the system forms no image.
   */
  renderOne({ screen, geometry, object, prescription, texture, preset, key }) {
    const started = now();
    // How far the farthest corner of the object is from the axis: the field ladder has to reach it,
    // or the corners of the picture would be drawn with the wrong aberration.
    const halfWidth = object.halfHeight * texture.width / texture.height;
    const objectRadius = Math.hypot(halfWidth, Math.abs(object.offsetY) + object.halfHeight);

    const field = traceSpotField({
      surfaces: prescription.surfaces,
      objectZ: object.z,
      objectRadius,
      screenZ: geometry.z,
      ambientIndex: prescription.ambientIndex,
      fieldSamples: preset.fieldSamples,
      pupilSamples: preset.pupilSamples,
    });
    if (!field) {
      screen.setPicture(null, { warnings: prescription.warnings, reason: 'noImage' });
      return null;
    }

    const traced = now();

    const request = {
      texture,
      objectHalfHeight: object.halfHeight,
      objectOffsetY: object.offsetY,
      spots: field.spots,
      objectRadius,
      screenHalfSize: geometry.halfHeight,
      outputSize: preset.outputSize,
    };

    const canvas = this.canvasFor(key, preset.outputSize);
    const context = canvas.getContext('2d');
    let clipped = false;
    let onGpu = false;

    const drawn = this.gpu && this.gpu.render(request);
    if (drawn) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(drawn, 0, 0);
      onGpu = true;
    } else {
      const picture = renderScreenImage(request);
      context.putImageData(
        new ImageData(picture.data, picture.width, picture.height), 0, 0
      );
      clipped = picture.clipped;
    }

    this.timings = {
      trace: traced - started,
      render: now() - traced,
      total: now() - started,
      onGpu,
      pupilSamples: preset.pupilSamples,
      outputSize: preset.outputSize,
    };

    // What the ideal system would have done, so that the quality bar is measured against the
    // scene's own optics rather than against a number the author had to guess.
    const paraxial = paraxialImage(prescription.surfaces, object.z, prescription.ambientIndex);

    // Where the farthest corner of the object landed: the size of the picture, measured from the
    // trace rather than from the paraxial formula, so that it is the size actually on the screen.
    const imageRadius = Math.abs(field.spots[field.spots.length - 1].centroid);

    const diagnostics = {
      rms: field.rms,
      maxIncidence: field.maxIncidence,
      objectRadius,
      imageRadius,
      imageMagnification: objectRadius > 0 ? imageRadius / objectRadius : 0,
      spots: field.spots,
      warnings: prescription.warnings,
      clipped,
      paraxialImageZ: paraxial ? paraxial.imageZ : null,
      magnification: paraxial ? paraxial.magnification : null,
      defocus: paraxial ? geometry.z - paraxial.imageZ : null,
    };

    // The target outline, at the size the scene says the picture should come out.
    if (screen.targetMagnification > 0) {
      screen.targetImage = this.sourceImage;
      screen.targetBox = {
        halfWidth: halfWidth * screen.targetMagnification,
        halfHeight: object.halfHeight * screen.targetMagnification,
      };
    } else {
      screen.targetImage = null;
      screen.targetBox = null;
    }

    screen.setPicture(canvas, diagnostics);
    return diagnostics;
  }

  /** Run the full-quality render once things have stopped moving. */
  scheduleSettle() {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.update({ preview: false });
    }, SETTLE_MS);
  }

  /** Stop any pending work. */
  destroy() {
    this.destroyed = true;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.gpu?.destroy();
    this.gpu = null;
  }
}

export { ScreenImageController, imageQuality };
export default ScreenImageController;
