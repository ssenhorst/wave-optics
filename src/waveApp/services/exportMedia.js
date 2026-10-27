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
 * @file Saving what the canvas shows: one frame as a PNG, or a stretch of time
 * as an MP4.
 *
 * The picture is four stacked canvases — background, grid, field and the
 * objects drawn above it — so every export first flattens them into one, in
 * that order, at the field canvas's pixel size.
 *
 * Video is rendered frame by frame at exact instants, not captured from the
 * screen as it plays, so a frame that is slow to compute only makes the export
 * take longer; the video itself always runs at its stated rate. Encoding uses
 * the browser's WebCodecs encoder, and Mediabunny writes the MP4 container.
 */

import { saveAs } from 'file-saver';
import {
  Output, Mp4OutputFormat, BufferTarget, CanvasSource, QUALITY_HIGH,
  getFirstEncodableVideoCodec,
} from 'mediabunny';

/** The canvas layers, bottom to top. */
const LAYER_IDS = ['waveCanvasBelow', 'waveCanvasGrid', 'waveCanvasField', 'waveCanvasAbove'];

/** Frames per second of exported video. */
export const VIDEO_FRAME_RATE = 30;

/**
 * Seconds one optical cycle takes in an exported video. The cycle is periodic,
 * so the video loops without a seam.
 */
export const CYCLE_SECONDS = 2;

/** Seconds a time-dependent scene's span takes, matching playback. */
export const SPAN_SECONDS = 12;

/**
 * Flatten the canvas layers into one canvas.
 *
 * The size is rounded down to even numbers, which H.264 requires; a PNG loses
 * at most one pixel row and column to it.
 *
 * @param {HTMLCanvasElement} target - Resized if it does not match.
 * @returns {HTMLCanvasElement} The target.
 */
export function flattenCanvas(target) {
  const field = document.getElementById('waveCanvasField');
  const width = field.width & ~1;
  const height = field.height & ~1;
  if (target.width !== width) target.width = width;
  if (target.height !== height) target.height = height;

  const ctx = target.getContext('2d');
  // The background layer is transparent where nothing is drawn; the page
  // behind it is black, so the export is too.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  for (const id of LAYER_IDS) {
    const layer = document.getElementById(id);
    if (layer && layer.width > 0 && layer.height > 0) {
      ctx.drawImage(layer, 0, 0, layer.width, layer.height, 0, 0, field.width, field.height);
    }
  }
  return target;
}

/**
 * Save the canvas as it is now.
 * @param {string} name - The file name, without extension.
 * @returns {Promise<void>}
 */
export function saveImage(name) {
  const canvas = flattenCanvas(document.createElement('canvas'));
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('The canvas could not be encoded as a PNG.'));
        return;
      }
      saveAs(blob, `${name}.png`);
      resolve();
    }, 'image/png');
  });
}

/**
 * The instants a video shows, in optical cycles.
 *
 * - `cycle`: one optical cycle from the current time, ending one frame short of
 *   a full turn so the video loops without repeating a frame.
 * - `span`: the scene's whole time span, end to end.
 *
 * @param {'cycle'|'span'} kind
 * @param {{time: number, timeSpan: number}} simulator
 * @returns {number[]}
 */
export function videoTimes(kind, simulator) {
  if (kind === 'cycle') {
    const count = VIDEO_FRAME_RATE * CYCLE_SECONDS;
    return Array.from({ length: count }, (_, i) => simulator.time + i / count);
  }
  const count = VIDEO_FRAME_RATE * SPAN_SECONDS;
  return Array.from({ length: count }, (_, i) => simulator.timeSpan * i / (count - 1));
}

/**
 * Render a stretch of time and save it as an MP4.
 *
 * @param {Object} options
 * @param {WaveSimulator} options.simulator
 * @param {'cycle'|'span'} options.kind - See {@link videoTimes}.
 * @param {string} options.name - The file name, without extension.
 * @param {function(number): void} [options.onProgress] - Called with the
 *   fraction of frames done.
 * @param {function(): boolean} [options.isCancelled] - Polled between frames.
 * @returns {Promise<boolean>} Whether a file was saved.
 */
export async function saveVideo({ simulator, kind, name, onProgress, isCancelled }) {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('This browser cannot encode video: it has no WebCodecs encoder.');
  }
  const canvas = flattenCanvas(document.createElement('canvas'));
  const codec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], {
    width: canvas.width, height: canvas.height,
  });
  if (!codec) throw new Error('This browser cannot encode video at this canvas size.');

  const times = videoTimes(kind, simulator);
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec, bitrate: QUALITY_HIGH });
  output.addVideoTrack(source, { frameRate: VIDEO_FRAME_RATE });
  await output.start();

  simulator.beginCapture();
  let cancelled = false;
  try {
    for (let i = 0; i < times.length; i++) {
      if (isCancelled?.()) {
        cancelled = true;
        break;
      }
      simulator.setTime(times[i]);
      flattenCanvas(canvas);
      await source.add(i / VIDEO_FRAME_RATE, 1 / VIDEO_FRAME_RATE);
      onProgress?.((i + 1) / times.length);
    }
  } finally {
    simulator.endCapture();
  }

  if (cancelled) {
    await output.cancel();
    return false;
  }
  await output.finalize();
  saveAs(new Blob([output.target.buffer], { type: 'video/mp4' }), `${name}.mp4`);
  return true;
}
