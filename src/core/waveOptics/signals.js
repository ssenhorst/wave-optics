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
 * @file The time dependence of a wave source.
 *
 * Every source radiates a carrier at the scene's wavelength, modulated by a
 * complex envelope `E(t)`. The real field is `Re{ Psi(r, t) e^{-i w t} }`,
 * where `Psi` is the sum over sources of the usual monochromatic contribution
 * multiplied by the envelope at the *retarded* time:
 *
 *     Psi(r, t) = sum_s  w_s K_s(r) E_s(t - n |r - r_s| / lambda)
 *
 * Time is measured in vacuum optical cycles, so light covers one vacuum
 * wavelength per unit of time and the delay over a distance `d` in a medium of
 * index `n` is `n d / lambda`.
 *
 * Freezing the kernel at the carrier is what makes a pulse arrive sharply and
 * leave nothing behind. The true 2D Green's function has a wake, because
 * Huygens' principle does not hold in two dimensions; this model drops it, as
 * if each source had been pre-filtered by `sqrt(-i w)`, while keeping the 2D
 * `1/sqrt(r)` decay that conserves energy in the plane. For a continuous wave
 * the envelope is one and the model is exactly the monochromatic one. For a
 * pulse it is exact in the far field and wrong only within about a wavelength
 * of a source, and it degrades gracefully as the bandwidth approaches the
 * carrier frequency.
 *
 * Signals are stored as flat properties on the source objects, so the default
 * (`cw`) is omitted when a scene is saved and existing scenes are unchanged.
 */

/** The available signal types. */
export const SIGNAL_TYPES = ['cw', 'pulse', 'switchOn', 'noise'];

/**
 * The signal properties shared by every wave source, with their defaults.
 * Spread into each source's `serializableDefaults`.
 *
 * - `signalType`: one of {@link SIGNAL_TYPES}.
 * - `signalDelay`: the pulse centre or switch-on time, in optical cycles.
 * - `signalDuration`: in optical cycles. The intensity FWHM of a pulse, the
 *   10–90% rise time of a switch-on, or the coherence time of noise.
 * - `signalSeed`: which realisation of noise. Sources with different seeds are
 *   mutually incoherent.
 */
export const SIGNAL_DEFAULTS = {
  signalType: 'cw',
  signalDelay: 0,
  signalDuration: 5,
  signalSeed: 0,
};

/**
 * The shortest duration accepted, in cycles. Below a cycle the envelope is no
 * longer slow compared with the carrier and the frozen-kernel model stops
 * meaning anything.
 */
export const MIN_SIGNAL_DURATION = 0.5;

/**
 * `ln 81`: the logistic `1 / (1 + e^{-a t / T})` rises from 10% to 90% over `T`
 * exactly when `a` is this.
 */
const LOGISTIC_10_90 = Math.log(81);

/** `2 ln 2`: a Gaussian amplitude `e^{-a t^2 / T^2}` has intensity FWHM `T` for this `a`. */
const GAUSSIAN_FWHM = 2 * Math.LN2;

/**
 * @typedef {Object} WaveSignal
 * @property {string} type - One of {@link SIGNAL_TYPES}.
 * @property {number} delay - In optical cycles.
 * @property {number} duration - In optical cycles.
 * @property {number} seed - A non-negative integer.
 */

/**
 * Read the signal off a source object, validating each property.
 * @param {Object} obj - A scene object carrying the {@link SIGNAL_DEFAULTS} properties.
 * @returns {WaveSignal}
 */
export function resolveSignal(obj) {
  const type = SIGNAL_TYPES.includes(obj?.signalType) ? obj.signalType : 'cw';
  const delay = Number.isFinite(obj?.signalDelay) ? obj.signalDelay : SIGNAL_DEFAULTS.signalDelay;
  const duration = Number.isFinite(obj?.signalDuration)
    ? Math.max(obj.signalDuration, MIN_SIGNAL_DURATION)
    : SIGNAL_DEFAULTS.signalDuration;
  const seed = Number.isFinite(obj?.signalSeed) ? Math.abs(Math.trunc(obj.signalSeed)) : 0;
  return { type, delay, duration, seed };
}

/**
 * Whether a signal is the plain continuous wave, which the monochromatic
 * engines handle without any notion of time.
 * @param {WaveSignal|undefined} signal
 * @returns {boolean}
 */
export function isContinuousWave(signal) {
  return !signal || signal.type === 'cw';
}

/**
 * An integer hash, `lowbias32` by Chris Wellons. Written with 32-bit integer
 * operations only so that the GLSL version gives bit-identical noise.
 * @param {number} x - Treated as an unsigned 32-bit integer.
 * @returns {number} An unsigned 32-bit integer.
 */
export function hash32(x) {
  x >>>= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * A uniform random number in `[0, 1)` for a noise knot.
 * @param {number} seed
 * @param {number} knot - Any integer, negative included.
 * @returns {number}
 */
function knotRandom(seed, knot) {
  return hash32(hash32(seed) ^ (knot >>> 0)) / 4294967296;
}

/**
 * The phase of a noise envelope.
 *
 * Noise here is phase noise: the envelope keeps unit magnitude and its phase
 * wanders, taking an independent uniformly random value at knots one coherence
 * time apart and interpolating smoothly between them along the shorter way
 * round. Two sources with different seeds therefore have no fixed phase
 * relation, and their interference averages away over a few coherence times,
 * while each one on its own is as bright as the continuous wave.
 *
 * @param {number} t - In optical cycles.
 * @param {number} duration - The coherence time, in optical cycles.
 * @param {number} seed
 * @returns {number} In radians.
 */
export function noisePhase(t, duration, seed) {
  const position = t / duration;
  const knot = Math.floor(position);
  const fraction = position - knot;
  const from = knotRandom(seed, knot) * 2 * Math.PI;
  const to = knotRandom(seed, knot + 1) * 2 * Math.PI;

  let step = to - from;
  step -= 2 * Math.PI * Math.round(step / (2 * Math.PI));
  const smooth = fraction * fraction * (3 - 2 * fraction);
  return from + step * smooth;
}

/**
 * The complex envelope of a signal at one instant.
 * @param {WaveSignal|undefined} signal - A missing signal is a continuous wave.
 * @param {number} t - In optical cycles.
 * @returns {{re: number, im: number}}
 */
export function signalEnvelope(signal, t) {
  if (isContinuousWave(signal)) return { re: 1, im: 0 };
  const { type, delay, duration, seed } = signal;
  const s = t - delay;

  switch (type) {
    case 'pulse':
      return { re: Math.exp(-GAUSSIAN_FWHM * s * s / (duration * duration)), im: 0 };
    case 'switchOn':
      return { re: 1 / (1 + Math.exp(-LOGISTIC_10_90 * s / duration)), im: 0 };
    case 'noise': {
      const phase = noisePhase(s, duration, seed);
      return { re: Math.cos(phase), im: Math.sin(phase) };
    }
    default:
      return { re: 1, im: 0 };
  }
}

/**
 * The code each signal type is stored under in the GPU's signal tables, which
 * hold `(code, delay, duration, seed)` per source.
 */
export const SIGNAL_TYPE_CODES = { cw: 0, pulse: 1, switchOn: 2, noise: 3 };

/**
 * The four floats a signal is uploaded as.
 * @param {WaveSignal|undefined} signal
 * @returns {number[]}
 */
export function signalRecord(signal) {
  if (isContinuousWave(signal)) return [SIGNAL_TYPE_CODES.cw, 0, 1, 0];
  return [SIGNAL_TYPE_CODES[signal.type], signal.delay, signal.duration, signal.seed];
}

/**
 * GLSL for {@link signalEnvelope}, generated from the same constants so the
 * shader and the reference implementation cannot drift apart. Defines
 * `vec2 signalEnvelope(vec4 record, float t)`, taking a record as written by
 * {@link signalRecord}.
 *
 * GLSL ES 3.00 converts between `int` and `uint` preserving the bit pattern,
 * which is what `>>> 0` does in {@link hash32}, so negative knots hash the same
 * way on both sides.
 *
 * @returns {string}
 */
export function buildSignalGlsl() {
  const float = (value) => {
    const text = String(value);
    return /[.e]/.test(text) ? text : `${text}.0`;
  };
  return `
uint hash32(uint x) {
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}

float knotRandom(uint seed, int knot) {
  return float(hash32(hash32(seed) ^ uint(knot))) / 4294967296.0;
}

float noisePhase(float t, float duration, uint seed) {
  const float TWO_PI = 6.283185307179586;
  float position = t / duration;
  float knotFloor = floor(position);
  int knot = int(knotFloor);
  float fraction = position - knotFloor;
  float startAngle = knotRandom(seed, knot) * TWO_PI;
  float endAngle = knotRandom(seed, knot + 1) * TWO_PI;
  float stepAngle = endAngle - startAngle;
  stepAngle -= TWO_PI * floor(stepAngle / TWO_PI + 0.5);
  float smoothed = fraction * fraction * (3.0 - 2.0 * fraction);
  return startAngle + stepAngle * smoothed;
}

vec2 signalEnvelope(vec4 record, float t) {
  int code = int(record.x + 0.5);
  if (code == ${SIGNAL_TYPE_CODES.cw}) return vec2(1.0, 0.0);
  float s = t - record.y;
  float duration = record.z;
  if (code == ${SIGNAL_TYPE_CODES.pulse}) {
    return vec2(exp(-${float(GAUSSIAN_FWHM)} * s * s / (duration * duration)), 0.0);
  }
  if (code == ${SIGNAL_TYPE_CODES.switchOn}) {
    // Clamped so the exponential cannot overflow long before the switch-on.
    float exponent = min(-${float(LOGISTIC_10_90)} * s / duration, 80.0);
    return vec2(1.0 / (1.0 + exp(exponent)), 0.0);
  }
  float phase = noisePhase(s, duration, uint(record.w));
  return vec2(cos(phase), sin(phase));
}
`;
}

export default {
  SIGNAL_TYPES,
  SIGNAL_DEFAULTS,
  resolveSignal,
  isContinuousWave,
  signalEnvelope,
};
