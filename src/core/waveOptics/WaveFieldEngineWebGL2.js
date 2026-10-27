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
 * @file The GPU backend.
 *
 * Three kinds of pass run here:
 *
 * 1. **Chain passes**, one per interface in order along the optical axis. Each
 *    evaluates the field arriving at that interface's sample sites from the
 *    subspace before it, multiplies by the transmission and the arc length, and
 *    leaves the result as the secondary-source weights radiating into the
 *    subspace beyond. These run sequentially because each depends on the last.
 * 2. **Field passes**, one per subspace, each drawing a full-screen quad that
 *    discards the pixels belonging to other subspaces. They share one float
 *    texture, which ends up holding the complex field over the whole view.
 * 3. **The display pass**, which colours that texture.
 *
 * The split matters for performance: a time-harmonic field does not depend on
 * time, so the first two run only when the scene changes, and animation re-runs
 * the third alone.
 *
 * A scene with time-dependent sources runs the same three kinds of pass in a
 * streaming form (see `timeDomain.js`). Each interface keeps a history of the
 * field that reached its sites, one column per time step in a ring buffer; a
 * frame fills the columns the clock has moved past, interface by interface, and
 * the field pass looks each site up at its own retarded time. Sources weight
 * their contribution by their signal's envelope at the retarded time, so the
 * texture then holds `Psi(r, t)` and the display pass needs no change at all.
 *
 * WebGL2 rather than WebGL1: rendering into a float texture needs
 * `EXT_color_buffer_float`, and indexing the source tables needs `texelFetch`.
 */

import { buildHankelGlsl } from './hankel.js';
import { wavenumber, minimumRadius } from './conventions.js';
import { getColormapTableRGBA, COLORMAP_SIZE } from './colormaps.js';
import { buildOklchGlsl, DEFAULT_PHASE_CHROMA } from './oklch.js';
import { FloatTable, BoundaryLut, BOUNDARY_LUT_WIDTH } from './gpuTables.js';
import { buildSignalGlsl, signalRecord } from './signals.js';
import {
  planHistory, historyShape, advanceHistory, slotRanges, HISTORY_MARGIN_SLOTS
} from './timeDomain.js';
import { subspaceIndexAt } from './waveSceneModel.js';

/** Texture units, fixed so the two summation programs bind identically. */
const UNIT_DIRECTIONAL_GEOMETRY = 0;
const UNIT_DIRECTIONAL_WEIGHTS = 1;
const UNIT_ISOTROPIC_GEOMETRY = 2;
const UNIT_ISOTROPIC_WEIGHTS = 3;
const UNIT_PLANE_GEOMETRY = 4;
const UNIT_PLANE_WEIGHTS = 5;
const UNIT_EXTRA_A = 6;
const UNIT_EXTRA_B = 7;
const UNIT_ISOTROPIC_SIGNALS = 8;
const UNIT_PLANE_SIGNALS = 9;

const FULLSCREEN_VERTEX_SHADER = `#version 300 es
// A single oversized triangle covering the viewport; no vertex buffer needed.
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * The summation both the chain and the field passes perform.
 *
 * Sources are ordered directional-first, matching the CPU reference, so no
 * per-source kind flag is needed: the first `uDirCount` entries came from an
 * interface and re-radiate through the Rayleigh-Sommerfeld kernel, and the
 * rest are isotropic point sources.
 */
const SUMMATION_GLSL = `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uDirGeometry;   // (x, y, nx, ny)
uniform sampler2D uDirWeights;    // (Re, Im, -, -)
uniform sampler2D uIsoGeometry;   // (x, y, -, -)
uniform sampler2D uIsoWeights;    // (Re, Im, -, -)
uniform sampler2D uPlaneGeometry; // (dir x, dir y, anchor x, anchor y)
uniform sampler2D uPlaneWeights;  // (Re, Im, -, -)
uniform int uDirCount;
uniform int uDirWidth;
uniform int uIsoCount;
uniform int uIsoWidth;
uniform int uPlaneCount;
uniform int uPlaneWidth;
uniform float uWavenumber;
uniform float uMinRadius;

${buildHankelGlsl()}

vec2 cmul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

vec2 sumField(vec2 p) {
  vec2 total = vec2(0.0);

  for (int i = 0; i < uDirCount; i++) {
    ivec2 uv = ivec2(i % uDirWidth, i / uDirWidth);
    vec4 site = texelFetch(uDirGeometry, uv, 0);
    vec2 weight = texelFetch(uDirWeights, uv, 0).xy;
    vec2 offset = p - site.xy;
    float r = max(length(offset), uMinRadius);
    float cosTheta = dot(site.zw, offset) / r;
    total += cmul(rayleighSommerfeldKernel(uWavenumber * r, cosTheta, uWavenumber), weight);
  }

  for (int i = 0; i < uIsoCount; i++) {
    ivec2 uv = ivec2(i % uIsoWidth, i / uIsoWidth);
    vec2 position = texelFetch(uIsoGeometry, uv, 0).xy;
    vec2 weight = texelFetch(uIsoWeights, uv, 0).xy;
    float r = max(distance(p, position), uMinRadius);
    total += cmul(greensFunction(uWavenumber * r), weight);
  }

  // Plane waves are evaluated in closed form. They are not built from point
  // sources, so they carry no aperture diffraction of their own.
  for (int i = 0; i < uPlaneCount; i++) {
    ivec2 uv = ivec2(i % uPlaneWidth, i / uPlaneWidth);
    vec4 wave = texelFetch(uPlaneGeometry, uv, 0);
    vec2 weight = texelFetch(uPlaneWeights, uv, 0).xy;
    float phase = uWavenumber * dot(wave.xy, p - wave.zw);
    total += cmul(vec2(cos(phase), sin(phase)), weight);
  }

  return total;
}
`;

const CHAIN_FRAGMENT_SHADER = `#version 300 es
${SUMMATION_GLSL}

uniform sampler2D uSiteGeometry;      // (x, y, nx, ny) of this interface
uniform sampler2D uSiteTransmission;  // (Re t, Im t, ds, -)

out vec4 fragColor;

void main() {
  ivec2 uv = ivec2(gl_FragCoord.xy);
  vec4 site = texelFetch(uSiteGeometry, uv, 0);
  vec4 transmission = texelFetch(uSiteTransmission, uv, 0);

  // Padding entries carry a zero transmission, so they contribute nothing.
  vec2 incident = sumField(site.xy);
  fragColor = vec4(cmul(transmission.xy, incident) * transmission.z, 0.0, 1.0);
}
`;

/**
 * The field pass, for either summation.
 * @param {string} summation - GLSL defining the summation function.
 * @param {string} sumExpression - The call that sums the field at `p`.
 * @param {string} [extraUniforms] - Declarations the call needs.
 * @returns {string}
 */
const fieldFragmentShader = (summation, sumExpression, extraUniforms = '') => `#version 300 es
${summation}
${extraUniforms}

uniform vec2 uGridOrigin;
uniform vec2 uGridStep;
uniform sampler2D uLowerLut;
uniform sampler2D uUpperLut;
uniform vec4 uLowerRange;   // (yMin, yMax, z below yMin, z above yMax)
uniform vec4 uUpperRange;
uniform int uHasLower;
uniform int uHasUpper;
// +1 when light travels towards +x, -1 when it travels the other way. Every
// subspace test is the same comparison with this factor on both sides.
uniform float uAxisSign;

out vec4 fragColor;

// Where an interface sits at a given transverse position. Past the ends it
// holds the axial position of the nearer end, which is what makes a short
// interface behave as an opaque screen continuing to the edges of the view.
float boundaryZ(sampler2D lut, vec4 range, float y) {
  if (y <= range.x) return range.z;
  if (y >= range.y) return range.w;
  float t = (y - range.x) / (range.y - range.x);
  float u = mix(0.5 / ${BOUNDARY_LUT_WIDTH}.0, (${BOUNDARY_LUT_WIDTH}.0 - 0.5) / ${BOUNDARY_LUT_WIDTH}.0, t);
  return texture(lut, vec2(u, 0.5)).r;
}

void main() {
  // uGridStep.y is negative: framebuffer row 0 is the bottom of the screen,
  // which is the largest scene y.
  vec2 p = uGridOrigin + uGridStep * (gl_FragCoord.xy - 0.5);

  float axial = uAxisSign * p.x;
  if (uHasLower == 1 && axial < uAxisSign * boundaryZ(uLowerLut, uLowerRange, p.y)) discard;
  if (uHasUpper == 1 && axial >= uAxisSign * boundaryZ(uUpperLut, uUpperRange, p.y)) discard;

  vec2 total = ${sumExpression};
  // The amplitude is stored alongside the complex field. The display pass
  // magnifies this texture with linear filtering, and interpolating a rapidly
  // oscillating Re/Im pair and *then* taking its magnitude loses amplitude
  // between samples, which shows up as false rings at the grid pitch. |U| is
  // smooth, so interpolating it directly is well behaved.
  fragColor = vec4(total, length(total), 1.0);
}
`;

const FIELD_FRAGMENT_SHADER = fieldFragmentShader(SUMMATION_GLSL, 'sumField(p)');

/**
 * The time-domain summation: {@link SUMMATION_GLSL} with every contribution
 * weighted by its envelope at the retarded time.
 *
 * Directional sources have no signal of their own. What they re-radiate is the
 * field that reached them, so their weight is read from the interface's
 * history at the retarded time, interpolated linearly between time steps. The
 * history already holds transmission times incident field times arc length,
 * which is the weight the monochromatic pass would have computed.
 */
const TIME_SUMMATION_GLSL = `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uDirGeometry;   // (x, y, nx, ny)
uniform sampler2D uDirHistory;    // (Re, Im), a row per site, a column per time step
uniform sampler2D uIsoGeometry;   // (x, y, -, -)
uniform sampler2D uIsoWeights;    // (Re, Im, -, -)
uniform sampler2D uIsoSignals;    // (code, delay, duration, seed)
uniform sampler2D uPlaneGeometry; // (dir x, dir y, anchor x, anchor y)
uniform sampler2D uPlaneWeights;  // (Re, Im, -, -)
uniform sampler2D uPlaneSignals;  // (code, delay, duration, seed)
uniform int uDirCount;
uniform int uDirWidth;
uniform int uDirRows;             // history rows per block
uniform int uIsoCount;
uniform int uIsoWidth;
uniform int uPlaneCount;
uniform int uPlaneWidth;
uniform float uWavenumber;
uniform float uMinRadius;
uniform float uDelayPerLength;    // n / lambda: optical cycles per scene unit

// The clock shared by every history: step m is at uHistoryEpoch + m uHistoryStep
// and lives in column m mod uHistorySlots; uHistoryNewest is the last step filled.
uniform int uHistorySlots;
uniform int uHistoryNewest;
uniform float uHistoryEpoch;
uniform float uHistoryStep;

${buildHankelGlsl()}
${buildSignalGlsl()}

vec2 cmul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

vec2 historyAt(int site, float tau) {
  int block = site / uDirRows;
  int row = site - block * uDirRows;
  // The window is sized so lookups land inside it; the clamp only guards the
  // first steps of a later interface, which nothing visible reads.
  float position = clamp(
    (tau - uHistoryEpoch) / uHistoryStep,
    float(uHistoryNewest - uHistorySlots + 1), float(uHistoryNewest)
  );
  float lower = floor(position);
  int m0 = int(lower);
  int m1 = min(m0 + 1, uHistoryNewest);
  int column = block * uHistorySlots;
  vec2 a = texelFetch(uDirHistory, ivec2(column + m0 % uHistorySlots, row), 0).xy;
  vec2 b = texelFetch(uDirHistory, ivec2(column + m1 % uHistorySlots, row), 0).xy;
  return mix(a, b, position - lower);
}

vec2 sumFieldAtTime(vec2 p, float t) {
  vec2 total = vec2(0.0);

  for (int i = 0; i < uDirCount; i++) {
    ivec2 uv = ivec2(i % uDirWidth, i / uDirWidth);
    vec4 site = texelFetch(uDirGeometry, uv, 0);
    vec2 offset = p - site.xy;
    float d = length(offset);
    float r = max(d, uMinRadius);
    float cosTheta = dot(site.zw, offset) / r;
    vec2 weight = historyAt(i, t - uDelayPerLength * d);
    total += cmul(rayleighSommerfeldKernel(uWavenumber * r, cosTheta, uWavenumber), weight);
  }

  for (int i = 0; i < uIsoCount; i++) {
    ivec2 uv = ivec2(i % uIsoWidth, i / uIsoWidth);
    vec2 position = texelFetch(uIsoGeometry, uv, 0).xy;
    vec2 weight = texelFetch(uIsoWeights, uv, 0).xy;
    vec4 signal = texelFetch(uIsoSignals, uv, 0);
    float d = distance(p, position);
    float r = max(d, uMinRadius);
    vec2 envelope = signalEnvelope(signal, t - uDelayPerLength * d);
    total += cmul(cmul(greensFunction(uWavenumber * r), weight), envelope);
  }

  for (int i = 0; i < uPlaneCount; i++) {
    ivec2 uv = ivec2(i % uPlaneWidth, i / uPlaneWidth);
    vec4 wave = texelFetch(uPlaneGeometry, uv, 0);
    vec2 weight = texelFetch(uPlaneWeights, uv, 0).xy;
    vec4 signal = texelFetch(uPlaneSignals, uv, 0);
    float travelled = dot(wave.xy, p - wave.zw);
    float phase = uWavenumber * travelled;
    vec2 envelope = signalEnvelope(signal, t - uDelayPerLength * travelled);
    total += cmul(cmul(vec2(cos(phase), sin(phase)), weight), envelope);
  }

  return total;
}
`;

/**
 * Fill time steps of one interface's history: each fragment is one site at
 * one step, and evaluates the field arriving there from the subspace before.
 */
const CHAIN_TIME_FRAGMENT_SHADER = `#version 300 es
${TIME_SUMMATION_GLSL}

uniform sampler2D uSiteGeometry;      // (x, y, nx, ny) of this interface
uniform sampler2D uSiteTransmission;  // (Re t, Im t, ds, delay in cycles)
uniform int uSiteCount;
uniform int uSiteWidth;               // row width of the two site tables
uniform int uSiteRows;                // rows per block of the history written

out vec4 fragColor;

void main() {
  ivec2 frag = ivec2(gl_FragCoord.xy);
  int block = frag.x / uHistorySlots;
  int slot = frag.x - block * uHistorySlots;
  int site = block * uSiteRows + frag.y;
  if (site >= uSiteCount) {
    fragColor = vec4(0.0);
    return;
  }

  // The step held in this column: the latest one at or before the newest.
  int stepIndex = uHistoryNewest - (uHistoryNewest - slot) % uHistorySlots;
  float tau = uHistoryEpoch + float(stepIndex) * uHistoryStep;

  ivec2 uv = ivec2(site % uSiteWidth, site / uSiteWidth);
  vec4 geometry = texelFetch(uSiteGeometry, uv, 0);
  vec4 transmission = texelFetch(uSiteTransmission, uv, 0);
  // The site re-radiates what reached it its own delay ago.
  vec2 incident = sumFieldAtTime(geometry.xy, tau - transmission.w);
  fragColor = vec4(cmul(transmission.xy, incident) * transmission.z, 0.0, 1.0);
}
`;

/**
 * The field at a list of points over a list of instants: each fragment is one
 * point (column) at one instant (row). Drawn once per subspace, each draw
 * keeping only the points that lie in it, as the field pass does by pixel.
 */
const PROBE_TIME_FRAGMENT_SHADER = `#version 300 es
${TIME_SUMMATION_GLSL}

uniform sampler2D uProbes;      // (x, y, subspace, time shift)
uniform sampler2D uProbeTimes;  // (t, -, -, -)
uniform int uProbeWidth;
uniform int uTimeWidth;
uniform int uTimeOffset;
uniform int uSubspace;

out vec4 fragColor;

void main() {
  ivec2 frag = ivec2(gl_FragCoord.xy);
  vec4 probe = texelFetch(uProbes, ivec2(frag.x % uProbeWidth, frag.x / uProbeWidth), 0);
  if (int(probe.z + 0.5) != uSubspace) discard;
  int k = frag.y + uTimeOffset;
  float t = texelFetch(uProbeTimes, ivec2(k % uTimeWidth, k / uTimeWidth), 0).x + probe.w;
  fragColor = vec4(sumFieldAtTime(probe.xy, t), 0.0, 1.0);
}
`;

const FIELD_TIME_FRAGMENT_SHADER = fieldFragmentShader(
  TIME_SUMMATION_GLSL, 'sumFieldAtTime(p, uTime)', 'uniform float uTime;'
);

const DISPLAY_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D uField;
uniform sampler2D uColormap;
uniform vec2 uResolution;
uniform int uView;          // 0 = intensity, 1 = field, 2 = amplitude/phase
uniform float uScale;       // reference amplitude the colour scale saturates at
uniform float uLowerCutoff; // intensity floor, as a fraction of full scale
uniform float uPhase;       // w t
uniform int uLogScale;
uniform float uDynamicRange; // decibels, when uLogScale is set
uniform float uChroma;       // peak chroma of the amplitude/phase view

out vec4 fragColor;

const float LN10 = 2.302585092994046;

${buildOklchGlsl()}

// Sample the colormap at texel centres so the ends are not half-clipped.
vec3 applyColormap(float t) {
  float u = mix(0.5 / ${COLORMAP_SIZE}.0, (${COLORMAP_SIZE}.0 - 0.5) / ${COLORMAP_SIZE}.0, clamp(t, 0.0, 1.0));
  return texture(uColormap, vec2(u, 0.5)).rgb;
}

void main() {
  vec4 fieldSample = texture(uField, gl_FragCoord.xy / uResolution);
  float scale = max(uScale, 1e-30);

  if (uView == 2) {
    // Amplitude and phase at once: |U| drives lightness, arg(U) becomes hue.
    // The time factor e^{-i w t} rotates the phase, so Play turns this into a
    // travelling-wave animation that still shows the amplitude envelope.
    float amplitude = clamp(fieldSample.z / scale, 0.0, 1.0);
    float phase = atan(fieldSample.y, fieldSample.x) - uPhase;
    fragColor = vec4(amplitudePhaseColor(amplitude, phase, uChroma), 1.0);
    return;
  }

  float t;

  if (uView == 1) {
    // Re{ U e^{-i w t} }, mapped symmetrically about the middle of the map.
    float value = fieldSample.x * cos(uPhase) + fieldSample.y * sin(uPhase);
    t = 0.5 + 0.5 * clamp(value / scale, -1.0, 1.0);
  } else {
    // fieldSample.z is |U|, interpolated directly rather than recomputed from
    // the interpolated Re/Im, which would ripple at the grid pitch.
    float intensity = fieldSample.z * fieldSample.z;
    float reference = scale * scale;
    if (uLogScale == 1) {
      float decibels = 10.0 * log(max(intensity, 1e-30) / reference) / LN10;
      t = (decibels + uDynamicRange) / uDynamicRange;
    } else {
      t = (intensity / reference - uLowerCutoff) / max(1.0 - uLowerCutoff, 1e-6);
    }
  }

  fragColor = vec4(applyColormap(t), 1.0);
}
`;

/**
 * Nearest filtering and clamped edges on the bound 2D texture, as every table
 * indexed with `texelFetch` wants.
 * @param {WebGL2RenderingContext} gl
 */
function setNearestClamped(gl) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

/**
 * Compile one shader stage, reporting the driver's log on failure.
 * @param {WebGL2RenderingContext} gl
 * @param {number} type
 * @param {string} source
 * @returns {WebGLShader}
 */
function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Wave field shader failed to compile: ${log}`);
  }
  return shader;
}

/**
 * Link a program from the shared full-screen vertex shader and a fragment shader.
 * @param {WebGL2RenderingContext} gl
 * @param {string} fragmentSource
 * @returns {WebGLProgram}
 */
function linkProgram(gl, fragmentSource) {
  const program = gl.createProgram();
  const vertex = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Wave field program failed to link: ${log}`);
  }
  return program;
}

/**
 * Look up several uniform locations at once.
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram} program
 * @param {string[]} names
 * @returns {Object<string, WebGLUniformLocation>}
 */
function collectUniforms(gl, program, names) {
  const uniforms = {};
  for (const name of names) uniforms[name] = gl.getUniformLocation(program, name);
  return uniforms;
}

const SUMMATION_UNIFORMS = [
  'uDirGeometry', 'uDirWeights', 'uIsoGeometry', 'uIsoWeights',
  'uPlaneGeometry', 'uPlaneWeights',
  'uDirCount', 'uDirWidth', 'uIsoCount', 'uIsoWidth',
  'uPlaneCount', 'uPlaneWidth',
  'uWavenumber', 'uMinRadius',
];

const TIME_SUMMATION_UNIFORMS = [
  'uDirGeometry', 'uDirHistory', 'uIsoGeometry', 'uIsoWeights', 'uIsoSignals',
  'uPlaneGeometry', 'uPlaneWeights', 'uPlaneSignals',
  'uDirCount', 'uDirWidth', 'uDirRows', 'uIsoCount', 'uIsoWidth',
  'uPlaneCount', 'uPlaneWidth',
  'uWavenumber', 'uMinRadius', 'uDelayPerLength',
  'uHistorySlots', 'uHistoryNewest', 'uHistoryEpoch', 'uHistoryStep',
];

const BOUNDARY_UNIFORMS = [
  'uGridOrigin', 'uGridStep',
  'uLowerLut', 'uUpperLut', 'uLowerRange', 'uUpperRange',
  'uHasLower', 'uHasUpper', 'uAxisSign',
];

/**
 * Obtain a WebGL2 context suitable for the wave renderer.
 * @param {HTMLCanvasElement} canvas
 * @returns {WebGL2RenderingContext}
 * @throws If WebGL2 or float render targets are unavailable.
 */
export function createWaveRenderingContext(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    // The field is drawn on demand, not once per frame, so the drawing buffer
    // must survive compositing. Without this the canvas can come back blank
    // after the compositor re-rasterises it with nothing having changed.
    preserveDrawingBuffer: true,
  });
  if (!gl) {
    throw new Error('WebGL2 is not available in this browser.');
  }
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new Error('EXT_color_buffer_float is not supported, so the field cannot be computed at floating point precision.');
  }
  return gl;
}

/**
 * The GPU field engine.
 * @class
 */
class WaveFieldEngineWebGL2 {
  /**
   * @param {WebGL2RenderingContext} gl
   */
  constructor(gl) {
    this.gl = gl;

    // Linear filtering of float textures is a separate extension. Without it
    // the field is still correct, just blocky when magnified.
    this.hasLinearFloat = Boolean(gl.getExtension('OES_texture_float_linear'));

    this.chainProgram = linkProgram(gl, CHAIN_FRAGMENT_SHADER);
    this.fieldProgram = linkProgram(gl, FIELD_FRAGMENT_SHADER);
    this.displayProgram = linkProgram(gl, DISPLAY_FRAGMENT_SHADER);

    this.chainUniforms = collectUniforms(gl, this.chainProgram, [
      ...SUMMATION_UNIFORMS, 'uSiteGeometry', 'uSiteTransmission',
    ]);
    this.fieldUniforms = collectUniforms(gl, this.fieldProgram, [
      ...SUMMATION_UNIFORMS, ...BOUNDARY_UNIFORMS,
    ]);

    // The time-domain programs are compiled on first use, so a scene with only
    // continuous waves never pays for them and cannot be broken by them.
    this.chainTimeProgram = null;
    this.fieldTimeProgram = null;
    this.displayUniforms = collectUniforms(gl, this.displayProgram, [
      'uField', 'uColormap', 'uResolution', 'uView', 'uScale',
      'uLowerCutoff', 'uPhase', 'uLogScale', 'uDynamicRange', 'uChroma',
    ]);

    // WebGL requires a bound vertex array even when the shader uses gl_VertexID.
    this.vertexArray = gl.createVertexArray();

    this.fieldTexture = gl.createTexture();
    this.framebuffer = gl.createFramebuffer();
    this.colormapTextures = new Map();

    /** Per-subspace source tables, grown as scenes need them. */
    this.subspaceTables = [];
    /** Per-interface boundary lookup tables. */
    this.boundaryLuts = [];

    /**
     * Per-subspace histories of the field reaching its interface sites,
     * indexed like the subspaces; the first subspace has none.
     */
    this.histories = [];
    /** Stands in for a history where a pass has none to read. */
    this.emptyHistory = null;
    /** The model the histories were laid out for. */
    this.timeModel = null;
    /** @property {Object|null} historyPlan - From `planHistory`, for that model. */
    this.historyPlan = null;
    /** `{epoch, newest}` of the filled window, or null when nothing is filled. */
    this.historyState = null;

    this.fieldWidth = 0;
    this.fieldHeight = 0;
    this.readbackBuffer = null;

    /** @property {Object|null} lastStats - Amplitude statistics of the last computed field. */
    this.lastStats = null;
  }

  /**
   * The table set for one subspace, created on first use.
   * @param {number} index
   * @returns {Object}
   * @private
   */
  tablesFor(index) {
    while (this.subspaceTables.length <= index) {
      const gl = this.gl;
      this.subspaceTables.push({
        siteGeometry: new FloatTable(gl),
        siteTransmission: new FloatTable(gl),
        // The chain pass renders into this one.
        siteWeights: new FloatTable(gl, true),
        primaryGeometry: new FloatTable(gl),
        primaryWeights: new FloatTable(gl),
        planeGeometry: new FloatTable(gl),
        planeWeights: new FloatTable(gl),
        primarySignals: new FloatTable(gl),
        planeSignals: new FloatTable(gl),
      });
    }
    return this.subspaceTables[index];
  }

  /**
   * The lookup table for one interface, created on first use.
   * @param {number} index
   * @returns {BoundaryLut}
   * @private
   */
  boundaryLutFor(index) {
    while (this.boundaryLuts.length <= index) {
      this.boundaryLuts.push(new BoundaryLut(this.gl, this.hasLinearFloat));
    }
    return this.boundaryLuts[index];
  }

  /**
   * Allocate (or reallocate) the float texture the field is computed into.
   * @param {number} width
   * @param {number} height
   * @private
   */
  resizeField(width, height) {
    const gl = this.gl;
    if (this.fieldWidth === width && this.fieldHeight === height) return;

    const filter = this.hasLinearFloat ? gl.LINEAR : gl.NEAREST;
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fieldTexture, 0
    );
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Wave field framebuffer is incomplete (status 0x${status.toString(16)}).`);
    }

    this.fieldWidth = width;
    this.fieldHeight = height;
    this.readbackBuffer = null;
  }

  /**
   * Upload one subspace's sources.
   * @param {number} index
   * @param {Object} subspace
   * @private
   */
  uploadSubspace(index, subspace) {
    const tables = this.tablesFor(index);
    const sites = subspace.surfaceSamples;
    const primaries = subspace.primaries;

    tables.siteGeometry.fill(sites.length, (i, buffer, at) => {
      buffer[at] = sites[i].x;
      buffer[at + 1] = sites[i].y;
      buffer[at + 2] = sites[i].nx;
      buffer[at + 3] = sites[i].ny;
    });
    tables.siteTransmission.fill(sites.length, (i, buffer, at) => {
      buffer[at] = sites[i].tRe;
      buffer[at + 1] = sites[i].tIm;
      buffer[at + 2] = sites[i].ds;
      // Only the time-domain chain reads this; the time-harmonic one ignores it.
      buffer[at + 3] = sites[i].delay ?? 0;
    });
    tables.siteWeights.allocate(sites.length);

    tables.primaryGeometry.fill(primaries.length, (i, buffer, at) => {
      buffer[at] = primaries[i].x;
      buffer[at + 1] = primaries[i].y;
    });
    tables.primaryWeights.fill(primaries.length, (i, buffer, at) => {
      buffer[at] = primaries[i].re;
      buffer[at + 1] = primaries[i].im;
    });
    tables.primarySignals.fill(primaries.length, (i, buffer, at) => {
      buffer.set(signalRecord(primaries[i].signal), at);
    });

    const planeWaves = subspace.planeWaves ?? [];
    tables.planeGeometry.fill(planeWaves.length, (i, buffer, at) => {
      buffer[at] = planeWaves[i].dirX;
      buffer[at + 1] = planeWaves[i].dirY;
      buffer[at + 2] = planeWaves[i].x;
      buffer[at + 3] = planeWaves[i].y;
    });
    tables.planeWeights.fill(planeWaves.length, (i, buffer, at) => {
      buffer[at] = planeWaves[i].re;
      buffer[at + 1] = planeWaves[i].im;
    });
    tables.planeSignals.fill(planeWaves.length, (i, buffer, at) => {
      buffer.set(signalRecord(planeWaves[i].signal), at);
    });
  }

  /**
   * Bind one subspace's tables as the sources to sum over.
   * @param {Object} uniforms
   * @param {number} index
   * @param {number} wavelength
   * @param {number} refractiveIndex
   * @private
   */
  bindSources(uniforms, index, wavelength, refractiveIndex) {
    const gl = this.gl;
    const tables = this.tablesFor(index);

    const bind = (unit, table, location) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, table.texture);
      gl.uniform1i(location, unit);
    };
    bind(UNIT_DIRECTIONAL_GEOMETRY, tables.siteGeometry, uniforms.uDirGeometry);
    bind(UNIT_DIRECTIONAL_WEIGHTS, tables.siteWeights, uniforms.uDirWeights);
    bind(UNIT_ISOTROPIC_GEOMETRY, tables.primaryGeometry, uniforms.uIsoGeometry);
    bind(UNIT_ISOTROPIC_WEIGHTS, tables.primaryWeights, uniforms.uIsoWeights);
    bind(UNIT_PLANE_GEOMETRY, tables.planeGeometry, uniforms.uPlaneGeometry);
    bind(UNIT_PLANE_WEIGHTS, tables.planeWeights, uniforms.uPlaneWeights);

    gl.uniform1i(uniforms.uDirCount, tables.siteGeometry.count);
    gl.uniform1i(uniforms.uDirWidth, tables.siteGeometry.width);
    gl.uniform1i(uniforms.uIsoCount, tables.primaryGeometry.count);
    gl.uniform1i(uniforms.uIsoWidth, tables.primaryGeometry.width);
    gl.uniform1i(uniforms.uPlaneCount, tables.planeGeometry.count);
    gl.uniform1i(uniforms.uPlaneWidth, tables.planeGeometry.width);
    gl.uniform1f(uniforms.uWavenumber, wavenumber(wavelength, refractiveIndex));
    gl.uniform1f(uniforms.uMinRadius, minimumRadius(wavelength, refractiveIndex));
  }

  /**
   * Run the whole computation: the propagation chain, then the field.
   *
   * @param {Object} model - As built by `buildWaveModel`.
   */
  computeField(model) {
    const gl = this.gl;
    const { subspaces, interfaces, grid, settings } = model;

    this.resizeField(grid.width, grid.height);
    for (let j = 0; j < subspaces.length; j++) this.uploadSubspace(j, subspaces[j]);
    for (let i = 0; i < interfaces.length; i++) {
      this.boundaryLutFor(i).update(interfaces[i]);
    }
    // The tables now hold this model, so histories laid out for another one
    // would be read against the wrong sources.
    if (this.timeModel !== model) this.timeModel = null;

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.vertexArray);

    this.runChainPasses(model);
    this.runFieldPasses(model);

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Block until the GPU has actually finished. Draw calls only queue work, so
    // without this the caller would time the submission rather than the
    // computation, and the resolution ladder would conclude that every grid is
    // free and climb to the top whatever the machine can do.
    gl.finish();

    this.lastStats = null;
  }

  /**
   * Carry the field across each interface in turn.
   * @param {Object} model
   * @private
   */
  runChainPasses({ subspaces, settings }) {
    const gl = this.gl;
    gl.useProgram(this.chainProgram);

    for (let j = 1; j < subspaces.length; j++) {
      const tables = this.tablesFor(j);
      if (tables.siteGeometry.count === 0) continue;

      // Sum over the subspace before this interface, in its medium.
      this.bindSources(
        this.chainUniforms, j - 1, settings.wavelength, subspaces[j - 1].refractiveIndex
      );

      gl.activeTexture(gl.TEXTURE0 + UNIT_EXTRA_A);
      gl.bindTexture(gl.TEXTURE_2D, tables.siteGeometry.texture);
      gl.uniform1i(this.chainUniforms.uSiteGeometry, UNIT_EXTRA_A);
      gl.activeTexture(gl.TEXTURE0 + UNIT_EXTRA_B);
      gl.bindTexture(gl.TEXTURE_2D, tables.siteTransmission.texture);
      gl.uniform1i(this.chainUniforms.uSiteTransmission, UNIT_EXTRA_B);

      gl.bindFramebuffer(gl.FRAMEBUFFER, tables.siteWeights.framebuffer);
      gl.viewport(0, 0, tables.siteWeights.width, tables.siteWeights.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  /**
   * Draw each subspace's field into the shared float texture.
   * @param {Object} model
   * @private
   */
  runFieldPasses({ subspaces, interfaces, grid, settings }) {
    const gl = this.gl;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, grid.width, grid.height);
    // Any pixel no subspace claims stays zero, which is the honest result for a
    // scene whose interfaces cross and so have no consistent ordering.
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.fieldProgram);
    gl.uniform2f(this.fieldUniforms.uGridOrigin, grid.originX, grid.originY);
    gl.uniform2f(this.fieldUniforms.uGridStep, grid.stepX, grid.stepY);
    gl.uniform1f(this.fieldUniforms.uAxisSign, settings.axisSign ?? 1);

    for (let j = 0; j < subspaces.length; j++) {
      this.bindSources(
        this.fieldUniforms, j, settings.wavelength, subspaces[j].refractiveIndex
      );
      this.bindBoundary(this.fieldUniforms, UNIT_EXTRA_A, j - 1, interfaces, 'uLowerLut', 'uLowerRange', 'uHasLower');
      this.bindBoundary(this.fieldUniforms, UNIT_EXTRA_B, j, interfaces, 'uUpperLut', 'uUpperRange', 'uHasUpper');
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  /**
   * Bind one of the two interfaces bounding the subspace being drawn.
   * @private
   */
  bindBoundary(uniforms, unit, interfaceIndex, interfaces, lutName, rangeName, flagName) {
    const gl = this.gl;
    const present = interfaceIndex >= 0 && interfaceIndex < interfaces.length;
    gl.uniform1i(uniforms[flagName], present ? 1 : 0);

    // A sampler must still be bound to something valid even when unused.
    const lut = this.boundaryLutFor(Math.max(0, Math.min(
      interfaceIndex, Math.max(0, interfaces.length - 1)
    )));
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, lut.texture);
    gl.uniform1i(uniforms[lutName], unit);
    if (present) gl.uniform4fv(uniforms[rangeName], lut.range);
  }

  /**
   * Compute the field of a time-dependent model at one instant.
   *
   * The histories are laid out once per model and then advanced: moving the
   * clock forward fills only the steps it passed, while a jump, a scrub
   * backwards past the spare steps, or a new model refills the whole window.
   * The field texture then holds `Psi(r, t)`, so the display pass shows it
   * with the phase `2 pi t` exactly as it shows a monochromatic field.
   *
   * @param {Object} model - As built by `buildWaveModel`.
   * @param {number} time - In optical cycles.
   * @returns {{refilled: boolean, stepsFilled: number}} What the histories needed.
   */
  computeFieldAtTime(model, time) {
    const gl = this.gl;
    this.ensureTimePrograms();

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.vertexArray);

    const advanced = this.advanceHistories(model, time);
    this.runFieldTimePasses(model, time);

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.lastStats = null;
    return advanced;
  }

  /**
   * Bring the histories to a time, laying them out first if the model is new.
   * Expects the vertex array bound and blending off.
   * @param {Object} model
   * @param {number} time
   * @returns {{refilled: boolean, stepsFilled: number}}
   * @private
   */
  advanceHistories(model, time) {
    if (this.timeModel !== model) this.prepareTimeDomain(model);
    const move = advanceHistory(this.historyState, time, this.historyPlan);
    this.historyState = { epoch: move.epoch, newest: move.newest };
    const stepsFilled = move.refill ? this.historyPlan.slots : Math.max(0, move.newest - move.from + 1);
    if (stepsFilled > 0) this.runHistoryPasses(model, move.refill ? 0 : move.from, move.newest);
    return { refilled: move.refill, stepsFilled };
  }

  /**
   * The time-dependent field at arbitrary points, at each of a list of
   * increasing instants.
   *
   * The histories keep a window that ends at the newest step, plus a margin of
   * spare steps before it. Instants are therefore taken in chunks no longer
   * than that margin: the histories are advanced to the end of a chunk, and
   * every instant in the chunk can then be looked up. A long list walks the
   * histories forward through the whole of it, so a frame drawn afterwards
   * refills them for its own time.
   *
   * @param {Object} model - As built by `buildWaveModel`.
   * A point may carry a `timeShift`, in cycles, added to every instant it is
   * evaluated at. It must keep that point's history lookups at or before the
   * instant itself, as {@link farFieldTimeShift} does, since the histories
   * are only advanced to the instants as given.
   *
   * @param {Array<{x: number, y: number, timeShift?: number}>} points
   * @param {number[]} times - In increasing order, in optical cycles.
   * @returns {Float32Array} For each instant, for each point, `(Re, Im)` of `Psi`.
   */
  fieldAtPointsOverTime(model, points, times) {
    const gl = this.gl;
    this.ensureTimePrograms();
    const out = new Float32Array(points.length * times.length * 2);
    if (points.length === 0 || times.length === 0) return out;

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.vertexArray);
    if (this.timeModel !== model) this.prepareTimeDomain(model);

    const axisSign = model.settings.axisSign ?? 1;
    this.probeTable.fill(points.length, (i, buffer, at) => {
      buffer[at] = points[i].x;
      buffer[at + 1] = points[i].y;
      buffer[at + 2] = subspaceIndexAt(model.interfaces, points[i].x, points[i].y, axisSign);
      buffer[at + 3] = points[i].timeShift ?? 0;
    });
    this.probeTimes.fill(times.length, (i, buffer, at) => { buffer[at] = times[i]; });

    // How far before the newest step a lookup can still be served, less one
    // step for the interpolation partner and one for rounding.
    const reach = (HISTORY_MARGIN_SLOTS - 2) * this.historyPlan.step;
    const maxRows = Math.min(times.length, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    const width = points.length;
    this.allocateProbeTarget(width, maxRows);
    const rowBuffer = new Float32Array(width * maxRows * 4);

    let first = 0;
    while (first < times.length) {
      let last = first;
      while (last + 1 < times.length && last + 1 - first < maxRows &&
        times[last + 1] - times[first] <= reach) last++;
      const rows = last - first + 1;

      this.advanceHistories(model, times[last]);
      this.runProbePasses(model, width, rows, first);

      gl.readPixels(0, 0, width, rows, gl.RGBA, gl.FLOAT, rowBuffer, 0);
      for (let r = 0; r < rows; r++) {
        for (let p = 0; p < width; p++) {
          const from = (r * width + p) * 4;
          const to = ((first + r) * width + p) * 2;
          out[to] = rowBuffer[from];
          out[to + 1] = rowBuffer[from + 1];
        }
      }
      first = last + 1;
    }

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /**
   * Make the probe target at least `width` by `height`.
   * @private
   */
  allocateProbeTarget(width, height) {
    const gl = this.gl;
    if (this.probeTarget.width >= width && this.probeTarget.height >= height) return;
    this.probeTarget.width = Math.max(width, this.probeTarget.width);
    this.probeTarget.height = Math.max(height, this.probeTarget.height);
    gl.bindTexture(gl.TEXTURE_2D, this.probeTarget.texture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA32F, this.probeTarget.width, this.probeTarget.height,
      0, gl.RGBA, gl.FLOAT, null
    );
    setNearestClamped(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.probeTarget.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.probeTarget.texture, 0
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Evaluate the probes at instants `offset` to `offset + rows - 1`.
   * @private
   */
  runProbePasses(model, width, rows, offset) {
    const gl = this.gl;
    const uniforms = this.probeTimeUniforms;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.probeTarget.framebuffer);
    gl.viewport(0, 0, width, rows);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.probeTimeProgram);

    gl.activeTexture(gl.TEXTURE0 + UNIT_EXTRA_A);
    gl.bindTexture(gl.TEXTURE_2D, this.probeTable.texture);
    gl.uniform1i(uniforms.uProbes, UNIT_EXTRA_A);
    gl.activeTexture(gl.TEXTURE0 + UNIT_EXTRA_B);
    gl.bindTexture(gl.TEXTURE_2D, this.probeTimes.texture);
    gl.uniform1i(uniforms.uProbeTimes, UNIT_EXTRA_B);
    gl.uniform1i(uniforms.uProbeWidth, this.probeTable.width);
    gl.uniform1i(uniforms.uTimeWidth, this.probeTimes.width);
    gl.uniform1i(uniforms.uTimeOffset, offset);

    for (let j = 0; j < model.subspaces.length; j++) {
      this.bindTimeSources(uniforms, j, model);
      gl.uniform1i(uniforms.uSubspace, j);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  /**
   * Compile the time-domain programs if they have not been yet.
   * @private
   */
  ensureTimePrograms() {
    if (this.chainTimeProgram) return;
    const gl = this.gl;
    this.chainTimeProgram = linkProgram(gl, CHAIN_TIME_FRAGMENT_SHADER);
    this.fieldTimeProgram = linkProgram(gl, FIELD_TIME_FRAGMENT_SHADER);
    this.probeTimeProgram = linkProgram(gl, PROBE_TIME_FRAGMENT_SHADER);
    this.probeTimeUniforms = collectUniforms(gl, this.probeTimeProgram, [
      ...TIME_SUMMATION_UNIFORMS, 'uProbes', 'uProbeTimes',
      'uProbeWidth', 'uTimeWidth', 'uTimeOffset', 'uSubspace',
    ]);
    this.probeTable = new FloatTable(gl);
    this.probeTimes = new FloatTable(gl);
    this.probeTarget = {
      texture: gl.createTexture(), framebuffer: gl.createFramebuffer(), width: 0, height: 0,
    };
    this.chainTimeUniforms = collectUniforms(gl, this.chainTimeProgram, [
      ...TIME_SUMMATION_UNIFORMS, 'uSiteGeometry', 'uSiteTransmission',
      'uSiteCount', 'uSiteWidth', 'uSiteRows',
    ]);
    this.fieldTimeUniforms = collectUniforms(gl, this.fieldTimeProgram, [
      ...TIME_SUMMATION_UNIFORMS, ...BOUNDARY_UNIFORMS, 'uTime',
    ]);

    this.emptyHistory = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.emptyHistory);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, 1, 1, 0, gl.RG, gl.FLOAT, new Float32Array(2));
    setNearestClamped(gl);
  }

  /**
   * Upload a model and lay out its histories.
   * @param {Object} model
   * @private
   */
  prepareTimeDomain(model) {
    const gl = this.gl;
    const { subspaces, interfaces, grid } = model;

    this.resizeField(grid.width, grid.height);
    for (let j = 0; j < subspaces.length; j++) this.uploadSubspace(j, subspaces[j]);
    for (let i = 0; i < interfaces.length; i++) this.boundaryLutFor(i).update(interfaces[i]);

    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.historyPlan = planHistory(model, { maxTextureSize });
    for (let j = 1; j < subspaces.length; j++) {
      const shape = historyShape(
        subspaces[j].surfaceSamples.length, this.historyPlan.slots, maxTextureSize
      );
      this.historyFor(j).allocate(shape);
    }

    this.timeModel = model;
    this.historyState = null;
  }

  /**
   * The history texture for one subspace, created on first use.
   * @param {number} index
   * @returns {Object}
   * @private
   */
  historyFor(index) {
    const gl = this.gl;
    while (this.histories.length <= index) {
      const history = {
        texture: gl.createTexture(),
        framebuffer: gl.createFramebuffer(),
        width: 0,
        height: 0,
        rows: 1,
        blocks: 1,
        allocate(shape) {
          this.rows = shape.rows;
          this.blocks = shape.blocks;
          if (this.width === shape.width && this.height === shape.height) return;
          this.width = shape.width;
          this.height = shape.height;
          gl.bindTexture(gl.TEXTURE_2D, this.texture);
          gl.texImage2D(
            gl.TEXTURE_2D, 0, gl.RG32F, shape.width, shape.height, 0, gl.RG, gl.FLOAT, null
          );
          setNearestClamped(gl);
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
          gl.framebufferTexture2D(
            gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0
          );
          const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          if (status !== gl.FRAMEBUFFER_COMPLETE) {
            throw new Error(`Wave history framebuffer is incomplete (status 0x${status.toString(16)}).`);
          }
        },
      };
      this.histories.push(history);
    }
    return this.histories[index];
  }

  /**
   * Bind one subspace's sources for a time-domain summation, along with the
   * shared clock.
   * @param {Object} uniforms
   * @param {number} index
   * @param {Object} model
   * @private
   */
  bindTimeSources(uniforms, index, model) {
    const gl = this.gl;
    const tables = this.tablesFor(index);
    const refractiveIndex = model.subspaces[index].refractiveIndex;
    const wavelength = model.settings.wavelength;
    const hasHistory = index > 0 && tables.siteGeometry.count > 0;
    const history = hasHistory ? this.histories[index] : null;

    const bind = (unit, texture, location) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(location, unit);
    };
    bind(UNIT_DIRECTIONAL_GEOMETRY, tables.siteGeometry.texture, uniforms.uDirGeometry);
    bind(UNIT_DIRECTIONAL_WEIGHTS, history ? history.texture : this.emptyHistory, uniforms.uDirHistory);
    bind(UNIT_ISOTROPIC_GEOMETRY, tables.primaryGeometry.texture, uniforms.uIsoGeometry);
    bind(UNIT_ISOTROPIC_WEIGHTS, tables.primaryWeights.texture, uniforms.uIsoWeights);
    bind(UNIT_ISOTROPIC_SIGNALS, tables.primarySignals.texture, uniforms.uIsoSignals);
    bind(UNIT_PLANE_GEOMETRY, tables.planeGeometry.texture, uniforms.uPlaneGeometry);
    bind(UNIT_PLANE_WEIGHTS, tables.planeWeights.texture, uniforms.uPlaneWeights);
    bind(UNIT_PLANE_SIGNALS, tables.planeSignals.texture, uniforms.uPlaneSignals);

    gl.uniform1i(uniforms.uDirCount, hasHistory ? tables.siteGeometry.count : 0);
    gl.uniform1i(uniforms.uDirWidth, tables.siteGeometry.width);
    gl.uniform1i(uniforms.uDirRows, history ? history.rows : 1);
    gl.uniform1i(uniforms.uIsoCount, tables.primaryGeometry.count);
    gl.uniform1i(uniforms.uIsoWidth, tables.primaryGeometry.width);
    gl.uniform1i(uniforms.uPlaneCount, tables.planeGeometry.count);
    gl.uniform1i(uniforms.uPlaneWidth, tables.planeGeometry.width);
    gl.uniform1f(uniforms.uWavenumber, wavenumber(wavelength, refractiveIndex));
    gl.uniform1f(uniforms.uMinRadius, minimumRadius(wavelength, refractiveIndex));
    gl.uniform1f(uniforms.uDelayPerLength, refractiveIndex / wavelength);

    gl.uniform1i(uniforms.uHistorySlots, this.historyPlan.slots);
    gl.uniform1i(uniforms.uHistoryNewest, this.historyState.newest);
    gl.uniform1f(uniforms.uHistoryEpoch, this.historyState.epoch);
    gl.uniform1f(uniforms.uHistoryStep, this.historyPlan.step);
  }

  /**
   * Fill steps `from` to `to` of every history, interface by interface along
   * the axis, so each reads a history already filled for the same steps.
   * @private
   */
  runHistoryPasses(model, from, to) {
    const gl = this.gl;
    const { subspaces } = model;
    const ranges = slotRanges(from, to, this.historyPlan.slots);
    gl.useProgram(this.chainTimeProgram);
    const uniforms = this.chainTimeUniforms;

    for (let j = 1; j < subspaces.length; j++) {
      const tables = this.tablesFor(j);
      if (tables.siteGeometry.count === 0) continue;
      const history = this.histories[j];

      // Sum over the subspace before this interface, in its medium.
      this.bindTimeSources(uniforms, j - 1, model);

      gl.activeTexture(gl.TEXTURE0 + UNIT_EXTRA_A);
      gl.bindTexture(gl.TEXTURE_2D, tables.siteGeometry.texture);
      gl.uniform1i(uniforms.uSiteGeometry, UNIT_EXTRA_A);
      gl.activeTexture(gl.TEXTURE0 + UNIT_EXTRA_B);
      gl.bindTexture(gl.TEXTURE_2D, tables.siteTransmission.texture);
      gl.uniform1i(uniforms.uSiteTransmission, UNIT_EXTRA_B);
      gl.uniform1i(uniforms.uSiteCount, tables.siteGeometry.count);
      gl.uniform1i(uniforms.uSiteWidth, tables.siteGeometry.width);
      gl.uniform1i(uniforms.uSiteRows, history.rows);

      gl.bindFramebuffer(gl.FRAMEBUFFER, history.framebuffer);
      for (let block = 0; block < history.blocks; block++) {
        for (const { start, count } of ranges) {
          gl.viewport(block * this.historyPlan.slots + start, 0, count, history.rows);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
      }
    }
  }

  /**
   * Draw each subspace's field at one instant into the shared float texture.
   * @private
   */
  runFieldTimePasses(model, time) {
    const gl = this.gl;
    const { subspaces, interfaces, grid, settings } = model;
    const uniforms = this.fieldTimeUniforms;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, grid.width, grid.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.fieldTimeProgram);
    gl.uniform2f(uniforms.uGridOrigin, grid.originX, grid.originY);
    gl.uniform2f(uniforms.uGridStep, grid.stepX, grid.stepY);
    gl.uniform1f(uniforms.uAxisSign, settings.axisSign ?? 1);
    gl.uniform1f(uniforms.uTime, time);

    for (let j = 0; j < subspaces.length; j++) {
      this.bindTimeSources(uniforms, j, model);
      this.bindBoundary(uniforms, UNIT_EXTRA_A, j - 1, interfaces, 'uLowerLut', 'uLowerRange', 'uHasLower');
      this.bindBoundary(uniforms, UNIT_EXTRA_B, j, interfaces, 'uUpperLut', 'uUpperRange', 'uHasUpper');
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  /**
   * Read the computed field back and summarise its amplitude distribution.
   *
   * The colour scale is taken from a high percentile rather than the maximum,
   * because the maximum sits at the logarithmic singularity of the Green's
   * function right at a source and would compress everything else to black.
   *
   * This is a GPU-to-CPU synchronisation point, so callers should do it only
   * on the final full-resolution pass, not while the user is dragging.
   *
   * @param {number} percentile - Between 0 and 100.
   * @returns {{referenceAmplitude: number, maxAmplitude: number, sampleCount: number}}
   */
  /**
   * Bring the computed field back from the GPU.
   *
   * Four floats per sample, in the field pass's layout: real part, imaginary
   * part, `|U|`, and a one. Rows run bottom to top, matching the grid built by
   * {@link computeFieldGrid}.
   *
   * This is the only way anything outside the shaders can look at the field, so
   * it is what the colour-scale statistics and the measurement objects both go
   * through. It is also not cheap — a full framebuffer transfer that stalls the
   * pipeline — so it is done once per change rather than per frame.
   *
   * @returns {Float32Array|null}
   */
  readField() {
    const gl = this.gl;
    const count = this.fieldWidth * this.fieldHeight;
    if (count === 0) return null;

    if (!this.readbackBuffer || this.readbackBuffer.length < count * 4) {
      this.readbackBuffer = new Float32Array(count * 4);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.readPixels(
      0, 0, this.fieldWidth, this.fieldHeight, gl.RGBA, gl.FLOAT, this.readbackBuffer
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.readbackBuffer;
  }

  readFieldStats(percentile = 99) {
    const count = this.fieldWidth * this.fieldHeight;
    if (count === 0) {
      return { referenceAmplitude: 0, maxAmplitude: 0, sampleCount: 0 };
    }

    this.readField();

    const amplitudes = new Float32Array(count);
    let maxAmplitude = 0;
    for (let i = 0; i < count; i++) {
      // Channel 2 is |U|, written by the field pass.
      const amplitude = this.readbackBuffer[i * 4 + 2];
      amplitudes[i] = amplitude;
      if (amplitude > maxAmplitude) maxAmplitude = amplitude;
    }

    amplitudes.sort();
    const index = Math.min(
      count - 1, Math.max(0, Math.round((percentile / 100) * (count - 1)))
    );

    this.lastStats = {
      referenceAmplitude: amplitudes[index] || maxAmplitude,
      maxAmplitude,
      sampleCount: count,
    };
    return this.lastStats;
  }

  /**
   * Colour the cached field onto the canvas.
   *
   * @param {Object} options
   * @param {string} options.view - 'intensity', 'field' or 'amplitudePhase'.
   * @param {string} options.colormap - Colormap identifier; unused by the
   *   amplitude-phase view, which has its own fixed bivariate mapping.
   * @param {number} options.referenceAmplitude - Amplitude the scale saturates at.
   * @param {number} [options.upperCutoff=1] - Multiplies the reference amplitude.
   * @param {number} [options.lowerCutoff=0] - Intensity floor, as a fraction of full scale.
   * @param {number} [options.phase=0] - The quantity `w t`.
   * @param {boolean} [options.logScale=false]
   * @param {number} [options.dynamicRange=40] - Decibels shown when `logScale` is set.
   * @param {number} [options.chroma] - Peak chroma of the amplitude-phase view.
   */
  render({
    view, colormap, referenceAmplitude, upperCutoff = 1, lowerCutoff = 0,
    phase = 0, logScale = false, dynamicRange = 40, chroma = DEFAULT_PHASE_CHROMA,
  }) {
    const gl = this.gl;
    const canvas = gl.canvas;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    gl.useProgram(this.displayProgram);
    gl.bindVertexArray(this.vertexArray);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTexture);
    gl.uniform1i(this.displayUniforms.uField, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.getColormapTexture(colormap));
    gl.uniform1i(this.displayUniforms.uColormap, 1);

    const viewIndex = view === 'field' ? 1 : (view === 'amplitudePhase' ? 2 : 0);
    gl.uniform2f(this.displayUniforms.uResolution, canvas.width, canvas.height);
    gl.uniform1i(this.displayUniforms.uView, viewIndex);
    gl.uniform1f(this.displayUniforms.uChroma, chroma);
    gl.uniform1f(this.displayUniforms.uScale, referenceAmplitude * upperCutoff);
    gl.uniform1f(this.displayUniforms.uLowerCutoff, lowerCutoff);
    gl.uniform1f(this.displayUniforms.uPhase, phase);
    gl.uniform1i(this.displayUniforms.uLogScale, logScale ? 1 : 0);
    gl.uniform1f(this.displayUniforms.uDynamicRange, dynamicRange);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /** Clear the canvas without drawing a field. */
  clear() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * The colormap lookup texture, uploaded on first use and then cached.
   * @param {string} name
   * @returns {WebGLTexture}
   * @private
   */
  getColormapTexture(name) {
    let texture = this.colormapTextures.get(name);
    if (texture) return texture;

    const gl = this.gl;
    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, COLORMAP_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      getColormapTableRGBA(name)
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.colormapTextures.set(name, texture);
    return texture;
  }

  /** Release every GL object this engine owns. */
  destroy() {
    const gl = this.gl;
    gl.deleteProgram(this.chainProgram);
    gl.deleteProgram(this.fieldProgram);
    gl.deleteProgram(this.displayProgram);
    if (this.chainTimeProgram) gl.deleteProgram(this.chainTimeProgram);
    if (this.fieldTimeProgram) gl.deleteProgram(this.fieldTimeProgram);
    if (this.probeTimeProgram) {
      gl.deleteProgram(this.probeTimeProgram);
      this.probeTable.destroy();
      this.probeTimes.destroy();
      gl.deleteTexture(this.probeTarget.texture);
      gl.deleteFramebuffer(this.probeTarget.framebuffer);
    }
    if (this.emptyHistory) gl.deleteTexture(this.emptyHistory);
    for (const history of this.histories) {
      gl.deleteTexture(history.texture);
      gl.deleteFramebuffer(history.framebuffer);
    }
    this.histories = [];
    this.timeModel = null;
    gl.deleteTexture(this.fieldTexture);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteVertexArray(this.vertexArray);
    for (const tables of this.subspaceTables) {
      for (const table of Object.values(tables)) table.destroy();
    }
    this.subspaceTables = [];
    for (const lut of this.boundaryLuts) lut.destroy();
    this.boundaryLuts = [];
    for (const texture of this.colormapTextures.values()) gl.deleteTexture(texture);
    this.colormapTextures.clear();
  }
}

export default WaveFieldEngineWebGL2;
