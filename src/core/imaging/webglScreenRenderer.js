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
 * @file `src/core/imaging/webglScreenRenderer.js` draws the picture on the screen with the GPU.
 *
 * The work the renderer does is a scatter: every point of the object sends light through every
 * point of the pupil, and each of those millions of contributions lands somewhere on the screen and
 * is added there. On the CPU that is a few million scattered writes to a float buffer, which is
 * about the least cache-friendly thing a CPU can be asked to do. On a GPU it is one draw call of a
 * few million points with additive blending, which is the thing graphics hardware has always been
 * for. The difference measures about twenty-fold.
 *
 * The optics is unchanged: {@link traceSpotField} still traces the rays on the CPU, because there
 * are only a few thousand of them and they are what the task is scored from. What moves to the GPU
 * is the spreading of the object's light over the screen, which is where the millions are.
 *
 * Everything here is optional. If WebGL2 or float blending is missing, {@link create} returns null
 * and the caller falls back to {@link renderScreenImage}, which produces the same picture.
 */

const ACCUMULATE_VERTEX = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

// (u, v, valid, 0) for every pupil sample at every traced field height.
uniform sampler2D uWarp;
// The object: where each of its opaque points is, and what colour it is.
uniform sampler2D uObjectPos;
uniform sampler2D uObjectColor;

uniform int uPupilSamples;
uniform int uFieldSamples;
uniform int uObjectWidth;
uniform float uFieldStep;
uniform float uPixelsPerUnit;
uniform float uScreenHalfSize;
uniform float uOutputSize;

out vec4 vColor;

void main() {
  int id = gl_VertexID;
  int pupil = id % uPupilSamples;
  int point = id / uPupilSamples;

  ivec2 pc = ivec2(point % uObjectWidth, point / uObjectWidth);
  vec2 o = texelFetch(uObjectPos, pc, 0).xy;
  vec4 colour = texelFetch(uObjectColor, pc, 0);

  // The frame the spot diagram was traced in: v away from the optical axis, u across it.
  float radius = length(o);
  vec2 e = radius > 1e-9 ? o / radius : vec2(0.0, 1.0);

  float position = min(radius / uFieldStep, float(uFieldSamples - 1) - 1e-4);
  int k0 = int(position);
  int k1 = min(k0 + 1, uFieldSamples - 1);
  float t = position - float(k0);

  vec4 near = texelFetch(uWarp, ivec2(pupil, k0), 0);
  vec4 far = texelFetch(uWarp, ivec2(pupil, k1), 0);

  vec2 uv;
  float weight = 1.0;
  if (near.z > 0.5 && far.z > 0.5) {
    // Both field heights were traced through this same pupil point, so the two landings are two
    // samples of one smooth map and interpolate directly.
    uv = mix(near.xy, far.xy, t);
  } else if (near.z > 0.5) {
    uv = near.xy;
    weight = 1.0 - t;
  } else if (far.z > 0.5) {
    uv = far.xy;
    weight = t;
  } else {
    // Vignetted at both ends: send the point outside the clip volume so nothing is drawn.
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    gl_PointSize = 1.0;
    vColor = vec4(0.0);
    return;
  }

  float sx = uv.x * e.y + uv.y * e.x;
  float sy = -uv.x * e.x + uv.y * e.y;
  vec2 pixel = (vec2(sx, sy) + uScreenHalfSize) * uPixelsPerUnit;

  // The picture is addressed with y downwards, as a canvas is, so y is flipped into clip space.
  gl_Position = vec4(
    pixel.x / uOutputSize * 2.0 - 1.0,
    1.0 - pixel.y / uOutputSize * 2.0,
    0.0, 1.0
  );
  gl_PointSize = 1.0;

  // Energy is divided over the whole pupil, not over the rays that survived, so a vignetted point
  // simply arrives dimmer.
  vColor = vec4(colour.rgb * colour.a * weight / float(uPupilSamples), 1.0);
}
`;

const ACCUMULATE_FRAGMENT = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() {
  outColor = vColor;
}
`;

const FULLSCREEN_VERTEX = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  // One oversized triangle covering the viewport, which needs no vertex buffer.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const REDUCE_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uSource;
uniform int uBlock;
uniform int uSourceSize;
in vec2 vUv;
out vec4 outColor;
void main() {
  // Average one block of the accumulation, so that the exposure is set from the brightness of a
  // region rather than from whichever single pixel happens to be hottest.
  ivec2 base = ivec2(gl_FragCoord.xy) * uBlock;
  vec3 total = vec3(0.0);
  float n = 0.0;
  for (int y = 0; y < 64; y++) {
    if (y >= uBlock) break;
    for (int x = 0; x < 64; x++) {
      if (x >= uBlock) break;
      ivec2 c = base + ivec2(x, y);
      if (c.x >= uSourceSize || c.y >= uSourceSize) continue;
      total += texelFetch(uSource, c, 0).rgb;
      n += 1.0;
    }
  }
  outColor = vec4(n > 0.0 ? total / n : vec3(0.0), 1.0);
}
`;

const TONEMAP_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uSource;
uniform float uGain;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 v = max(texture(uSource, vUv).rgb * uGain, 0.0);
  // sRGB-ish gamma, so that the faint skirts of an aberrated spot are visible at all.
  outColor = vec4(pow(min(v, vec3(1.0)), vec3(1.0 / 2.2)), 1.0);
}
`;

/**
 * Compile a shader, or throw with the log.
 * @param {WebGL2RenderingContext} gl - The context.
 * @param {number} type - The shader type.
 * @param {string} source - The source.
 * @returns {WebGLShader} The shader.
 */
function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`screen renderer shader failed to compile: ${log}`);
  }
  return shader;
}

/**
 * Link a program from two sources.
 * @param {WebGL2RenderingContext} gl - The context.
 * @param {string} vertex - The vertex shader source.
 * @param {string} fragment - The fragment shader source.
 * @returns {WebGLProgram} The program.
 */
function link(gl, vertex, fragment) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`screen renderer program failed to link: ${log}`);
  }
  return program;
}

/**
 * Draws the picture on an imaging screen with the GPU.
 * @class
 */
class WebglScreenRenderer {
  /**
   * Try to set one up.
   * @returns {WebglScreenRenderer|null} The renderer, or null if this browser cannot do it.
   */
  static create() {
    if (typeof document === 'undefined') return null;
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      });
      if (!gl) return null;

      // Accumulating light means adding floats together in a framebuffer. Without both of these
      // the picture would be clipped to 1.0 after the first few rays and tell the student nothing.
      if (!gl.getExtension('EXT_color_buffer_float')) return null;
      if (!gl.getExtension('EXT_float_blend')) return null;

      return new WebglScreenRenderer(canvas, gl);
    } catch (e) {
      // Falling back to the CPU is fine, but doing it silently is not: a shader that stops
      // compiling after an edit would otherwise look like a mysterious twenty-fold slowdown.
      console.warn('Imaging screens are falling back to the CPU renderer:', e.message);
      WebglScreenRenderer.lastError = e.message;
      return null;
    }
  }

  /**
   * @param {HTMLCanvasElement} canvas - The canvas the GPU draws into.
   * @param {WebGL2RenderingContext} gl - The context.
   */
  constructor(canvas, gl) {
    /** @property {HTMLCanvasElement} canvas - The canvas the GPU draws into. */
    this.canvas = canvas;
    /** @property {WebGL2RenderingContext} gl - The context. */
    this.gl = gl;

    this.accumulateProgram = link(gl, ACCUMULATE_VERTEX, ACCUMULATE_FRAGMENT);
    this.reduceProgram = link(gl, FULLSCREEN_VERTEX, REDUCE_FRAGMENT);
    this.tonemapProgram = link(gl, FULLSCREEN_VERTEX, TONEMAP_FRAGMENT);

    this.vao = gl.createVertexArray();

    this.warpTexture = gl.createTexture();
    this.objectPosTexture = gl.createTexture();
    this.objectColorTexture = gl.createTexture();

    this.accumTexture = gl.createTexture();
    this.accumFbo = gl.createFramebuffer();
    this.accumSize = 0;

    this.reduceTexture = gl.createTexture();
    this.reduceFbo = gl.createFramebuffer();
    this.reduceSize = 32;
    this.reduceBuffer = new Float32Array(this.reduceSize * this.reduceSize * 4);

    this.objectCache = { texture: null, halfHeight: 0, offsetY: 0, width: 0, height: 0, count: 0 };
    this.lost = false;

    canvas.addEventListener('webglcontextlost', () => { this.lost = true; });
  }

  /** @returns {boolean} Whether the renderer is still usable. */
  get usable() {
    return !this.lost && !this.gl.isContextLost();
  }

  /**
   * Upload a texture of 32-bit floats.
   * @param {WebGLTexture} texture - The texture.
   * @param {number} width - The width.
   * @param {number} height - The height.
   * @param {Float32Array|null} data - The data, RGBA.
   * @param {number} [internalFormat] - The internal format, RGBA32F by default.
   * @param {number} [format] - The format, RGBA by default.
   */
  uploadFloat(texture, width, height, data, internalFormat, format) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, internalFormat ?? gl.RGBA32F, width, height, 0,
      format ?? gl.RGBA, gl.FLOAT, data
    );
  }

  /**
   * Flatten the object into the opaque points the GPU will draw, one vertex per point per pupil
   * sample. Transparent pixels are dropped here rather than in the shader, because they are most of
   * the picture's bounding box and a vertex that draws nothing still costs a vertex.
   * @param {Object} texture - The object's pixels.
   * @param {number} objectHalfHeight - Half the object's height in scene units.
   * @param {number} objectOffsetY - How far the object's centre is off the axis.
   * @returns {{count: number, width: number, height: number}} How the points were laid out.
   */
  uploadObject(texture, objectHalfHeight, objectOffsetY) {
    // The object changes only when the scene's picture or its placement changes, which is almost
    // never, while the lenses move constantly. Flattening it on every render would put the cost
    // the GPU was brought in to remove straight back on the CPU.
    const cache = this.objectCache;
    if (cache.texture === texture
      && cache.halfHeight === objectHalfHeight
      && cache.offsetY === objectOffsetY) {
      return cache;
    }

    const objectScale = (2 * objectHalfHeight) / texture.height;
    const halfWidth = texture.width * objectScale / 2;
    const pixels = texture.width * texture.height;

    // Sized for the worst case and filled as far as it goes, rather than grown element by element.
    const positions = new Float32Array(pixels * 4);
    const colours = new Float32Array(pixels * 4);
    let count = 0;

    for (let iy = 0; iy < texture.height; iy++) {
      const oy = (iy + 0.5) * objectScale - objectHalfHeight + objectOffsetY;
      for (let ix = 0; ix < texture.width; ix++) {
        const base = (iy * texture.width + ix) * 4;
        const alpha = texture.data[base + 3];
        if (alpha < 1) continue;
        const red = texture.data[base];
        const green = texture.data[base + 1];
        const blue = texture.data[base + 2];
        if (red + green + blue === 0) continue;
        const at = count * 4;
        positions[at] = (ix + 0.5) * objectScale - halfWidth;
        positions[at + 1] = oy;
        colours[at] = red / 255;
        colours[at + 1] = green / 255;
        colours[at + 2] = blue / 255;
        colours[at + 3] = alpha / 255;
        count++;
      }
    }

    // A square-ish layout, so that neither dimension can exceed the maximum texture size.
    const width = Math.max(1, Math.ceil(Math.sqrt(count)));
    const height = Math.max(1, Math.ceil(count / width));

    const posData = new Float32Array(width * height * 4);
    const colData = new Float32Array(width * height * 4);
    posData.set(positions.subarray(0, count * 4));
    colData.set(colours.subarray(0, count * 4));

    this.uploadFloat(this.objectPosTexture, width, height, posData);
    this.uploadFloat(this.objectColorTexture, width, height, colData);

    this.objectCache = {
      texture, halfHeight: objectHalfHeight, offsetY: objectOffsetY, count, width, height,
    };
    return this.objectCache;
  }

  /**
   * Make sure the accumulation target is the right size.
   * @param {number} size - The side of the picture in pixels.
   */
  resize(size) {
    const gl = this.gl;
    if (this.accumSize === size) return;

    this.uploadFloat(this.accumTexture, size, size, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.accumTexture, 0
    );

    this.uploadFloat(this.reduceTexture, this.reduceSize, this.reduceSize, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.reduceFbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.reduceTexture, 0
    );

    this.canvas.width = size;
    this.canvas.height = size;
    this.accumSize = size;
  }

  /**
   * Render the picture.
   * @param {Object} params - The same parameters {@link renderScreenImage} takes.
   * @returns {HTMLCanvasElement|null} The canvas holding the picture, or null if it could not be
   * drawn and the caller should fall back to the CPU.
   */
  render(params) {
    if (!this.usable) return null;
    const gl = this.gl;
    const {
      texture, objectHalfHeight, objectOffsetY = 0, spots,
      objectRadius, screenHalfSize, outputSize,
    } = params;

    const fieldSamples = spots.length;
    const pupilSamples = spots[0].valid.length;
    if (!fieldSamples || !pupilSamples) return null;

    // The traced map: for every pupil sample at every field height, where it lands and whether it
    // got there at all.
    const warp = new Float32Array(pupilSamples * fieldSamples * 4);
    for (let k = 0; k < fieldSamples; k++) {
      const spot = spots[k];
      for (let i = 0; i < pupilSamples; i++) {
        const at = (k * pupilSamples + i) * 4;
        warp[at] = spot.landings[i * 2];
        warp[at + 1] = spot.landings[i * 2 + 1];
        warp[at + 2] = spot.valid[i];
      }
    }
    this.uploadFloat(this.warpTexture, pupilSamples, fieldSamples, warp);

    const object = this.uploadObject(texture, objectHalfHeight, objectOffsetY);
    if (!object.count) return null;

    this.resize(outputSize);

    // Accumulate.
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbo);
    gl.viewport(0, 0, outputSize, outputSize);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.disable(gl.DEPTH_TEST);

    const program = this.accumulateProgram;
    gl.useProgram(program);
    const set = (name, fn, ...args) => fn.call(gl, gl.getUniformLocation(program, name), ...args);
    set('uPupilSamples', gl.uniform1i, pupilSamples);
    set('uFieldSamples', gl.uniform1i, fieldSamples);
    set('uObjectWidth', gl.uniform1i, object.width);
    set('uFieldStep', gl.uniform1f, objectRadius / Math.max(1, fieldSamples - 1));
    set('uPixelsPerUnit', gl.uniform1f, outputSize / (2 * screenHalfSize));
    set('uScreenHalfSize', gl.uniform1f, screenHalfSize);
    set('uOutputSize', gl.uniform1f, outputSize);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.warpTexture);
    set('uWarp', gl.uniform1i, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.objectPosTexture);
    set('uObjectPos', gl.uniform1i, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.objectColorTexture);
    set('uObjectColor', gl.uniform1i, 2);

    gl.drawArrays(gl.POINTS, 0, object.count * pupilSamples);
    gl.disable(gl.BLEND);

    const gain = this.measureExposure(outputSize);

    // Tone map onto the visible canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outputSize, outputSize);
    gl.useProgram(this.tonemapProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accumTexture);
    gl.uniform1i(gl.getUniformLocation(this.tonemapProgram, 'uSource'), 0);
    gl.uniform1f(gl.getUniformLocation(this.tonemapProgram, 'uGain'), gain);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (gl.getError() !== gl.NO_ERROR) return null;
    return this.canvas;
  }

  /**
   * Work out how bright to make the picture.
   *
   * The exposure is taken from a high percentile of a heavily downsampled copy rather than from the
   * brightest pixel, so that one hot pixel cannot darken everything else and a badly blurred image
   * stays visible instead of fading to black. The downsampling happens on the GPU, so the readback
   * is a few kilobytes rather than the whole float image.
   * @param {number} size - The side of the accumulation.
   * @returns {number} The gain to apply.
   */
  measureExposure(size) {
    const gl = this.gl;
    const block = Math.max(1, Math.ceil(size / this.reduceSize));

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.reduceFbo);
    gl.viewport(0, 0, this.reduceSize, this.reduceSize);
    gl.useProgram(this.reduceProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accumTexture);
    gl.uniform1i(gl.getUniformLocation(this.reduceProgram, 'uSource'), 0);
    gl.uniform1i(gl.getUniformLocation(this.reduceProgram, 'uBlock'), block);
    gl.uniform1i(gl.getUniformLocation(this.reduceProgram, 'uSourceSize'), size);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.readPixels(
      0, 0, this.reduceSize, this.reduceSize, gl.RGBA, gl.FLOAT, this.reduceBuffer
    );

    const luminance = [];
    for (let i = 0; i < this.reduceSize * this.reduceSize; i++) {
      const value = 0.2126 * this.reduceBuffer[i * 4]
        + 0.7152 * this.reduceBuffer[i * 4 + 1]
        + 0.0722 * this.reduceBuffer[i * 4 + 2];
      if (value > 0) luminance.push(value);
    }
    if (!luminance.length) return 0;
    luminance.sort((a, b) => a - b);

    // Averaging over a block loses the peak, so the percentile of the averages is lifted a little
    // to land where the full-resolution percentile would.
    const exposure = luminance[Math.floor(luminance.length * 0.98)] * 1.35;
    return exposure > 0 ? 1 / exposure : 0;
  }

  /** Release the GPU resources. */
  destroy() {
    const gl = this.gl;
    for (const texture of [this.warpTexture, this.objectPosTexture, this.objectColorTexture,
      this.accumTexture, this.reduceTexture]) {
      gl.deleteTexture(texture);
    }
    gl.deleteFramebuffer(this.accumFbo);
    gl.deleteFramebuffer(this.reduceFbo);
    gl.deleteProgram(this.accumulateProgram);
    gl.deleteProgram(this.reduceProgram);
    gl.deleteProgram(this.tonemapProgram);
    gl.deleteVertexArray(this.vao);
    this.lost = true;
  }
}

export default WebglScreenRenderer;
export { WebglScreenRenderer };
