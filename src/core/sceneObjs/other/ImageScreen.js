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

import BaseSceneObj from '../BaseSceneObj.js';
import LineObjMixin from '../LineObjMixin.js';
import i18next from 'i18next';

/**
 * A screen that shows the picture the optical system throws on it.
 *
 * Tools -> Other -> Imaging screen
 *
 * A ray diagram is a cross section through the optical axis: it says where the light goes, but the
 * thing a student is actually trying to produce — a picture — lies in the plane perpendicular to the
 * drawing, which the diagram never shows. This object is the bridge. In the diagram it is a bar
 * standing across the axis, and on that bar it draws the plane it occupies turned towards the
 * viewer, carrying the image the system forms at exactly that position. Slide it along the axis and
 * the picture sharpens and blurs, so the diagram's focus and the picture's sharpness are visibly the
 * same fact.
 *
 * The object only holds the geometry and draws what it is given; the trace that produces the picture
 * lives in `src/core/imaging/`, and a controller hands the result back through {@link setPicture}.
 * That keeps an expensive, asynchronous render out of the drawing path, which is called on every
 * frame.
 *
 * @class
 * @extends BaseSceneObj
 * @memberof sceneObjs
 * @property {Point} p1 - One end of the screen.
 * @property {Point} p2 - The other end.
 * @property {number} panelScale - How large the turned-towards-you panel is drawn, relative to the
 * screen's own height. 1 draws it at the size the screen really is.
 * @property {boolean} showFrame - Whether to draw a frame and corner marks around the panel.
 * @property {string} caption - A label drawn under the panel, or the empty string for none.
 * @property {number} targetMagnification - The size the picture is supposed to be, as a multiple of
 * the object's own size, or 0 for no target. It is drawn as a dashed outline of the object on the
 * panel: something to aim at, so that a student cannot reach a sharp picture by quietly letting it
 * shrink, which is what moving the screen to the circle of least confusion would otherwise do.
 */
class ImageScreen extends LineObjMixin(BaseSceneObj) {
  static type = 'ImageScreen';
  static serializableDefaults = {
    p1: null,
    p2: null,
    panelScale: 1,
    showFrame: true,
    caption: '',
    targetMagnification: 0
  };

  constructor(scene, properties) {
    super(scene, properties);

    /**
     * @property {HTMLCanvasElement|null} picture - The rendered image, set by the controller. It is
     * deliberately not serialized: it is derived from the rest of the scene, and a scene file that
     * carried a stale picture of a system it no longer describes would be a trap.
     */
    this.picture = null;

    /** @property {Object|null} diagnostics - What the last render measured, for the task goals. */
    this.diagnostics = null;

    /** @property {HTMLImageElement|null} targetImage - The object's picture, for the target outline. */
    this.targetImage = null;

    /** @property {Object|null} targetBox - The half width and half height of the target, in scene units. */
    this.targetBox = null;
  }

  static getDescription(objData, scene, detailed = false) {
    return i18next.t('main:tools.ImageScreen.title');
  }

  static getPropertySchema(objData, scene) {
    return [
      ...super.getPropertySchema(objData, scene),
      { key: 'panelScale', type: 'number', label: i18next.t('simulator:sceneObjs.ImageScreen.panelScale') },
      { key: 'showFrame', type: 'boolean', label: i18next.t('simulator:sceneObjs.ImageScreen.showFrame') },
      { key: 'targetMagnification', type: 'number', label: i18next.t('simulator:sceneObjs.ImageScreen.targetMagnification') },
    ];
  }

  populateObjBar(objBar) {
    objBar.setTitle(i18next.t('main:tools.ImageScreen.title'));
    objBar.createNumber(i18next.t('simulator:sceneObjs.ImageScreen.panelScale'), 0.2, 3, 0.1, this.panelScale, function (obj, value) {
      obj.panelScale = value;
    });
    objBar.createBoolean(i18next.t('simulator:sceneObjs.ImageScreen.showFrame'), this.showFrame, function (obj, value) {
      obj.showFrame = value;
    });
  }

  /**
   * The centre of the screen and its height, which is what the renderer needs to know.
   * @returns {{centre: Point, halfHeight: number, z: number}|null} The geometry, or null if the
   * screen has no extent.
   */
  getGeometry() {
    if (!this.p1 || !this.p2) return null;
    const halfHeight = Math.hypot(this.p2.x - this.p1.x, this.p2.y - this.p1.y) / 2;
    if (!(halfHeight > 0)) return null;
    return {
      centre: { x: (this.p1.x + this.p2.x) / 2, y: (this.p1.y + this.p2.y) / 2 },
      halfHeight,
      z: (this.p1.x + this.p2.x) / 2,
    };
  }

  /**
   * Hand the screen a freshly rendered picture.
   * @param {HTMLCanvasElement|null} picture - The picture, already square.
   * @param {Object|null} diagnostics - What the render measured: `rms`, `quality` and so on.
   */
  setPicture(picture, diagnostics = null) {
    this.picture = picture;
    this.diagnostics = diagnostics;
  }

  draw(canvasRenderer, isAboveLight, isHovered) {
    const ctx = canvasRenderer.ctx;
    const ls = canvasRenderer.lengthScale;
    const geometry = this.getGeometry();

    if (!geometry) {
      if (this.p1) {
        ctx.fillStyle = 'rgb(128,128,128)';
        ctx.fillRect(this.p1.x - 1.5 * ls, this.p1.y - 1.5 * ls, 3 * ls, 3 * ls);
      }
      return;
    }

    // The picture is drawn under the rays, so that the light is seen falling onto it rather than
    // the panel sitting on top of the diagram.
    if (!isAboveLight) {
      this.drawPanel(ctx, geometry, ls);
      return;
    }

    // The screen itself, edge on: a plain bar across the axis.
    ctx.save();
    ctx.strokeStyle = isHovered ? 'rgb(255,255,0)' : 'rgb(220,220,220)';
    ctx.lineWidth = 3 * ls;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(this.p1.x, this.p1.y);
    ctx.lineTo(this.p2.x, this.p2.y);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Draw the plane of the screen turned towards the viewer, with the rendered picture on it.
   * @param {CanvasRenderingContext2D} ctx - The context, in scene coordinates.
   * @param {Object} geometry - The screen geometry from {@link getGeometry}.
   * @param {number} ls - The length scale of the renderer.
   */
  drawPanel(ctx, geometry, ls) {
    const side = 2 * geometry.halfHeight * this.panelScale;
    const left = geometry.centre.x - side / 2;
    const top = geometry.centre.y - side / 2;

    ctx.save();

    // An unlit screen is still a screen: draw the surface even before the first render arrives, so
    // the student can see what they are dragging.
    ctx.fillStyle = 'rgba(10,10,14,0.92)';
    ctx.fillRect(left, top, side, side);

    if (this.picture) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.picture, left, top, side, side);
    }

    this.drawTarget(ctx, geometry, ls);

    if (this.showFrame) {
      ctx.strokeStyle = 'rgba(190,200,215,0.75)';
      ctx.lineWidth = 1 * ls;
      ctx.strokeRect(left, top, side, side);

      // Corner marks, which read as "this is a plane you are looking at face on" rather than as a
      // rectangle lying in the diagram.
      const tick = Math.min(side * 0.12, 14 * ls);
      ctx.lineWidth = 2 * ls;
      ctx.strokeStyle = 'rgba(125,211,252,0.9)';
      ctx.beginPath();
      for (const [cx, cy, sx, sy] of [
        [left, top, 1, 1], [left + side, top, -1, 1],
        [left, top + side, 1, -1], [left + side, top + side, -1, -1],
      ]) {
        ctx.moveTo(cx + sx * tick, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + sy * tick);
      }
      ctx.stroke();
    }

    if (this.caption) {
      ctx.fillStyle = 'rgba(220,228,240,0.9)';
      ctx.font = `${Math.round(11 * ls)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(this.caption, geometry.centre.x, top + side + 16 * ls);
    }

    ctx.restore();
  }

  /**
   * Draw the outline of the picture the student is aiming for.
   *
   * It is the object itself, at the size it is supposed to come out and the way up a real image
   * comes out, drawn as a faint ghost inside a dashed box. Showing the object rather than an
   * abstract rectangle is the point: it says what to compare against, edge for edge, which is how
   * blur is actually judged by eye.
   * @param {CanvasRenderingContext2D} ctx - The context, in scene coordinates.
   * @param {Object} geometry - The screen geometry.
   * @param {number} ls - The length scale.
   */
  drawTarget(ctx, geometry, ls) {
    if (!this.targetMagnification || !this.targetBox) return;

    const { halfWidth, halfHeight } = this.targetBox;
    if (!(halfWidth > 0) || !(halfHeight > 0)) return;

    const cx = geometry.centre.x;
    const cy = geometry.centre.y;

    if (this.targetImage && this.targetImage.complete && this.targetImage.naturalWidth) {
      ctx.save();
      ctx.globalAlpha = 0.22;
      // A real image is reversed both ways, which is how the picture on the screen will come out.
      ctx.translate(cx, cy);
      ctx.scale(-1, -1);
      ctx.drawImage(this.targetImage, -halfWidth, -halfHeight, halfWidth * 2, halfHeight * 2);
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = 'rgba(240,180,41,0.9)';
    ctx.lineWidth = 1.5 * ls;
    ctx.setLineDash([6 * ls, 5 * ls]);
    ctx.strokeRect(cx - halfWidth, cy - halfHeight, halfWidth * 2, halfHeight * 2);
    ctx.restore();
  }

  /**
   * The panel is drawn around the screen, so the whole of it has to count as part of the object for
   * the view to be framed on it correctly.
   * @returns {Array<Point>|null} The corners of the panel.
   */
  getBoundingPoints() {
    const geometry = this.getGeometry();
    if (!geometry) return null;
    const half = geometry.halfHeight * this.panelScale;
    return [
      { x: geometry.centre.x - half, y: geometry.centre.y - half },
      { x: geometry.centre.x + half, y: geometry.centre.y + half },
    ];
  }
}

export default ImageScreen;
