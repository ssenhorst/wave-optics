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
 * @file Renders every wave-optics picture the site and the editor use: the home
 * page carousel and field views, the tool icons that appear both on the home
 * page and in the editor's tool menus, the gallery thumbnails of the examples
 * and of the assignments, and the favicon.
 *
 * Unlike the ray-optics gallery images, which are drawn by the node build of
 * the core library, these are screenshots of the real app driven in a headless
 * browser. The field is computed by a WebGL2 shader and coloured by another
 * one; reproducing both in node would mean a second implementation of the
 * display mapping that could drift from the one people actually see. Driving
 * the app instead means a preview is by construction what the app shows.
 *
 * The cost is that this needs a browser, so it is deliberately *not* part of
 * `npm run build`: the output is committed, and this is run by hand when the
 * examples or the rendering change.
 *
 *     npm run build-app          # or build-simulator, for a dist/ to serve
 *     npm run build-tasks        # only needed for --only=tasks
 *     node ./scripts/buildWaveImages.mjs
 *
 * Puppeteer is not a dependency of this project. Point NODE_PATH at an install
 * of it, or `npm i --no-save puppeteer` first.
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { EXAMPLE_SCENES } from '../src/waveApp/exampleScenes.js';

// CommonJS resolution, which unlike `import()` honours NODE_PATH — the way an
// install of puppeteer outside this project is pointed at.
const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT_DIR = path.join(ROOT, 'src/img/wave');
const TASKS_OUT_DIR = path.join(ROOT, 'src/img/tasks');

/** Grid resolution the previews are computed at, in place of the adaptive ladder. */
const PREVIEW_RESOLUTION = 512;

/** How long to let the field computation and the refinement settle, in ms. */
const SETTLE_MS = 6000;

/**
 * The previews the pages ask for.
 *
 * `wide` ones head the home page carousel, `view` ones show the same scene in
 * each of the three field views, `square` ones are gallery thumbnails and
 * category tiles.
 */
const CAROUSEL = ['twoPointSources', 'zonePlate', 'lens', 'grating', 'fiveSlits'];

/**
 * One scene, shown in each field view, for the "views" section.
 *
 * Plane-wave illuminated rather than one of the point-source examples: a point
 * source is orders of magnitude brighter than the pattern it forms, so it
 * saturates into a white disc that dominates all three mappings and shows off
 * none of them.
 */
const VIEW_SCENE = 'fiveSlits';
const VIEWS = ['intensity', 'field', 'amplitudePhase'];

/** The tile that heads each tool category on the home page. */
const CATEGORY_TILES = {
  sources: 'twoPointSources',
  interfaces: 'grating',
  measure: 'focusMeasurement',
};

/** The viewport the per-tool scenes below are composed for. */
const TOOL_VIEWPORT = { width: 640, height: 640 };

/** Wavelength the tool scenes use, chosen so a few fringes fit in the tile. */
const TOOL_WAVELENGTH = 22;

const planeWave = (x, y, angle = 0) =>
  ({ type: 'WavePlaneWave', x, y, angle, amplitude: 1 });

const element = (type, x, halfHeight, extra = {}) => ({
  type,
  p1: { x, y: 320 - halfHeight },
  p2: { x, y: 320 + halfHeight },
  refractiveIndexAfter: 1,
  ...extra,
});

/**
 * One scene per tool, each composed to say what that tool is at the size of an
 * icon: what it does has to be legible at forty pixels in a dropdown as well as
 * at two hundred on the home page, so each is a single element doing the one
 * thing it is for, with nothing else in the frame.
 *
 * The view is chosen per tool rather than fixed. A source reads best as
 * wavefronts, which is the instantaneous field; what an interface does to a
 * beam reads best as where the light ends up, which is the intensity.
 */
const TOOL_SCENES = {
  WavePointSource: {
    view: 'field',
    objs: [{ type: 'WavePointSource', x: 320, y: 320, amplitude: 1, phase: 0 }],
  },
  WaveLineSource: {
    view: 'field',
    upperCutoff: 1.6,
    objs: [{
      type: 'WaveLineSource',
      p1: { x: 150, y: 200 }, p2: { x: 150, y: 440 }, amplitude: 1,
    }],
  },
  WavePlaneWave: {
    view: 'field',
    objs: [planeWave(120, 320, 20)],
  },
  WaveInterface: {
    view: 'intensity',
    upperCutoff: 1.4,
    objs: [
      { type: 'WaveLineSource', p1: { x: 60, y: 210 }, p2: { x: 60, y: 430 }, amplitude: 1 },
      // Tilted and dense, so the beam visibly bends towards the normal.
      element('WaveInterface', 300, 400, { refractiveIndexAfter: 1.8, eqnSag: '0.6\\cdot y' }),
    ],
  },
  WaveLens: {
    view: 'intensity',
    upperCutoff: 1.6,
    objs: [
      planeWave(60, 320),
      element('WaveLens', 220, 150, { focalLength: 300, refractiveIndex: 1.5, thickness: 8 }),
    ],
  },
  WaveMultiSlit: {
    view: 'intensity',
    upperCutoff: 0.6,
    objs: [
      planeWave(60, 320),
      element('WaveMultiSlit', 200, 300, {
        slitCount: 2, slitWidth: TOOL_WAVELENGTH, slitSpacing: 6 * TOOL_WAVELENGTH,
        profileDisplay: 'amplitudePhase',
      }),
    ],
  },
  WaveSquareGrating: {
    view: 'intensity',
    upperCutoff: 1.8,
    objs: [
      planeWave(60, 320),
      element('WaveSquareGrating', 200, 300, {
        pitch: 3 * TOOL_WAVELENGTH, dutyCycle: 0.5, profileDisplay: 'amplitudePhase',
      }),
    ],
  },
  WaveSinusoidalGrating: {
    view: 'intensity',
    upperCutoff: 1.8,
    objs: [
      planeWave(60, 320),
      element('WaveSinusoidalGrating', 200, 300, {
        pitch: 3 * TOOL_WAVELENGTH, maxPhaseShift: 2.4,
        profileDisplay: 'amplitudePhase',
      }),
    ],
  },
  WaveZonePlate: {
    view: 'intensity',
    upperCutoff: 1.1,
    objs: [
      planeWave(60, 320),
      element('WaveZonePlate', 180, 260, { focalLength: 320, phaseReversing: true,
        profileDisplay: 'amplitudePhase' }),
    ],
  },
  WaveBinaryMask: {
    view: 'intensity',
    upperCutoff: 0.8,
    objs: [
      planeWave(60, 320),
      element('WaveBinaryMask', 200, 300, {
        eqnMask: '\\cos\\left(0.06\\cdot y\\right)', profileDisplay: 'amplitudePhase',
      }),
    ],
  },
  WaveScreen: {
    view: 'intensity',
    upperCutoff: 0.6,
    objs: [
      planeWave(40, 320),
      element('WaveMultiSlit', 150, 260, {
        slitCount: 2, slitWidth: TOOL_WAVELENGTH, slitSpacing: 5 * TOOL_WAVELENGTH,
      }),
      {
        type: 'WaveScreen',
        p1: { x: 400, y: 80 }, p2: { x: 400, y: 560 },
        plotMode: 'intensity', alwaysShowPlot: true, plotHeight: 150,
      },
    ],
  },
  WaveFocusProbe: {
    view: 'intensity',
    upperCutoff: 1.6,
    objs: [
      planeWave(40, 320),
      element('WaveLens', 170, 140, { focalLength: 280, refractiveIndex: 1.5, thickness: 8 }),
      { type: 'WaveFocusProbe', x: 330, y: 190, units: 'wavelengths' },
    ],
  },
  WavePointMeasurement: {
    view: 'intensity',
    upperCutoff: 1.6,
    objs: [
      planeWave(40, 320),
      element('WaveMultiSlit', 200, 260, {
        slitCount: 2, slitWidth: TOOL_WAVELENGTH, slitSpacing: 5 * TOOL_WAVELENGTH,
      }),
      { type: 'WavePointMeasurement', x: 410, y: 245 },
    ],
  },
};

/**
 * The scene the favicon is made from: the fan a double slit throws, with the
 * scene markers hidden and the slits just off the left edge, so the icon is
 * the pattern rather than a picture of an experiment.
 */
const FAVICON = {
  view: 'intensity',
  upperCutoff: 0.55,
  hideObjects: true,
  objs: [
    planeWave(40, 320),
    element('WaveMultiSlit', 130, 320, {
      slitCount: 2, slitWidth: TOOL_WAVELENGTH, slitSpacing: 5 * TOOL_WAVELENGTH,
    }),
  ],
  crop: { left: 150, top: 75, width: 490, height: 490 },
};

/** Sizes the favicon is written at, largest first. */
const FAVICON_SIZES = [256, 180, 32];

/**
 * The assignments shown in the gallery, which are the wave-optics ones: the
 * pages `npm run build-tasks` writes to `dist/tasks/`.
 *
 * Read from the scene files rather than listed here, so an assignment added to
 * `data/taskScenes` is picked up without this script being edited.
 *
 * @returns {Array<{id: string, title: string, description: string}>}
 */
function waveTasks() {
  const dir = path.join(ROOT, 'data/taskScenes');
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json') && name !== 'index.json' && !name.startsWith('.'))
    .map((name) => ({ id: name.slice(0, -'.json'.length), scene: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) }))
    .filter(({ scene }) => (scene.objs ?? []).some((obj) => String(obj?.type ?? '').startsWith('Wave')))
    .map(({ id, scene }) => ({
      id,
      title: scene.task?.title ?? id,
      description: scene.task?.description ?? '',
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

/** Serve `dist/` so the app can be loaded by the browser. */
function serve() {
  const server = http.createServer((req, res) => {
    let file = path.join(DIST, decodeURIComponent(req.url.split('?')[0]));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      file = path.join(file, 'index.html');
    }
    if (!file.startsWith(DIST) || !fs.existsSync(file)) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * Load one example, wait for the field, and return the page ready to shoot.
 * @param {Object} page - A puppeteer page.
 * @param {string} base - The server's base URL.
 * @param {string} exampleId
 */
async function loadExample(page, base, exampleId) {
  await page.goto(`${base}/wave/#${exampleId}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => Boolean(window.waveApp?.simulator), { timeout: 30000 });

  // The chrome is an overlay, so hiding it leaves the canvases untouched
  // underneath and the preview is the field alone.
  await page.addStyleTag({
    content: '.wave-chrome, .wave-status, #wave_obj_bar { display: none !important; }',
  });

  // A fixed resolution rather than the adaptive ladder, so a preview does not
  // depend on how fast the machine that rendered it happened to be.
  await page.evaluate((resolution) => {
    const app = window.waveApp;
    app.scene.waveOptics.autoResolution = false;
    app.scene.waveOptics.gridResolution = resolution;
    app.editor.selectObj(-1);
    app.simulator.updateSimulation(false, true);
  }, PREVIEW_RESOLUTION);

  await new Promise((r) => setTimeout(r, SETTLE_MS));
}

/**
 * Load one of the hand-composed scenes above, rather than a built-in example.
 *
 * The scene is given in the coordinates of {@link TOOL_VIEWPORT} and the page
 * is sized to match, so the composition lands where it was written to.
 *
 * @param {Object} page
 * @param {string} base
 * @param {Object} scene - `{ view, upperCutoff, objs }`.
 */
async function loadScene(page, base, scene) {
  await page.goto(`${base}/wave/`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => Boolean(window.waveApp?.simulator), { timeout: 30000 });
  await page.addStyleTag({
    content: '.wave-chrome, .wave-status, #wave_obj_bar { display: none !important; }'
      // The objects draw themselves on their own canvas layer, so dropping it
      // leaves the field alone. A tool icon wants its element drawn; a favicon
      // is a pattern rather than a scene, and a source marker in it is litter.
      + (scene.hideObjects ? ' #waveCanvasAbove { display: none !important; }' : ''),
  });

  await page.evaluate((spec, resolution, wavelength) => {
    const app = window.waveApp;
    app.editor.loadJSON(JSON.stringify({
      version: 5,
      objs: spec.objs,
      origin: { x: 0, y: 0 },
      scale: 1,
      width: spec.width,
      height: spec.height,
      waveOptics: {
        wavelength,
        refractiveIndex: 1,
        sourceDensity: 8,
        gridResolution: resolution,
        autoResolution: false,
        view: spec.view ?? 'intensity',
        upperCutoff: spec.upperCutoff ?? 1,
      },
    }));
    app.editor.selectObj(-1);
    app.simulator.updateSimulation(false, true);
  }, scene, PREVIEW_RESOLUTION, TOOL_WAVELENGTH);

  await new Promise((r) => setTimeout(r, SETTLE_MS));
}

/**
 * Load one built assignment page and wait for its field.
 *
 * Unlike the app, a task page is the embeddable applet with no global handle on
 * it, so there is nothing to drive: it is waited on and photographed as a
 * student would meet it, at the state the scene is authored in. The crop is
 * taken from the applet's own stage element, which is the canvas area left of
 * the assignment panel — the panel is a wall of text that says nothing at
 * thumbnail size.
 *
 * @param {Object} page - A puppeteer page.
 * @param {string} base - The server's base URL.
 * @param {string} id - The task's id, which is its scene's file name.
 * @returns {Promise<Object>} The stage's bounding box, as a sharp extract box.
 */
async function loadTaskPage(page, base, id) {
  await page.goto(`${base}/tasks/${id}.html`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.ro-stage canvas', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, SETTLE_MS));

  return page.evaluate(() => {
    const rect = document.querySelector('.ro-stage').getBoundingClientRect();
    return {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  });
}

/** Set the field view and re-colour, without recomputing the field. */
async function setView(page, view) {
  await page.evaluate((v) => {
    window.waveApp.scene.waveOptics.view = v;
    window.waveApp.simulator.render();
  }, view);
  await new Promise((r) => setTimeout(r, 400));
}

/**
 * Shoot the viewport and write it out, cropped to the requested aspect ratio
 * about the centre of the picture.
 *
 * `fit` is the usual sharp one: `cover` fills the frame and loses what does not
 * fit, which is what a preview of a scene composed to fill the window wants;
 * `contain` fits the whole picture inside the frame against `background`, which
 * is what a scene wider than the frame wants when none of it may be lost.
 */
async function shoot(page, sharp, outPath, { width, height, crop, fit = 'cover', background = '#000' }) {
  const buffer = await page.screenshot({ type: 'png' });
  const image = sharp(buffer);
  const meta = await image.metadata();

  // Cropping about the centre keeps the part of the scene the example was
  // composed around; the examples are built to fill the window they load into.
  const box = crop ?? { left: 0, top: 0, width: meta.width, height: meta.height };
  await image
    .extract(box)
    .resize(width, height, { fit, background })
    .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
    .toFile(outPath);
  console.log('  wrote', path.relative(ROOT, outPath));
}

/**
 * A crop of the given aspect ratio, as a sharp extract box.
 *
 * @param {{width: number, height: number}} viewport
 * @param {number} aspect
 * @param {number} [bias=0.5] - Where along the width to centre the crop. The
 *   examples put their optics in the left third and the pattern they form to
 *   the right of it, so a tight crop wants to sit downstream of centre.
 * @param {number} [zoom=1] - Fraction of the available size to take. A wide
 *   aspect already fills the viewport's width, so there is nothing for `bias`
 *   to move until the crop is made smaller than it needs to be.
 */
function centredCrop(viewport, aspect, bias = 0.5, zoom = 1) {
  let width = Math.round(viewport.width * zoom);
  let height = Math.round(width / aspect);
  if (height > viewport.height) {
    height = viewport.height;
    width = Math.round(height * aspect);
  }
  const free = viewport.width - width;
  // `left`/`top` let the box be taken from a region that is not the whole page,
  // which is how a crop of one element rather than of the viewport is asked for.
  return {
    left: (viewport.left ?? 0) + Math.round(free * Math.min(1, Math.max(0, bias))),
    top: (viewport.top ?? 0) + Math.round((viewport.height - height) / 2),
    width,
    height,
  };
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'wave', 'index.html'))) {
    console.error('dist/wave is missing. Run `npm run build-simulator` first.');
    process.exit(1);
  }

  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (e) {
    console.error(
      'puppeteer is not resolvable. It is not a dependency of this project;\n' +
      'either `npm i --no-save puppeteer` or set NODE_PATH to an install of it.'
    );
    process.exit(1);
  }
  const sharp = require('sharp');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { server, port } = await serve();
  const base = `http://127.0.0.1:${port}`;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      // The field is computed on the GPU, so a software rasteriser has to be
      // available for this to run anywhere without one.
      '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    ],
  });

  // `--only=views,carousel` re-renders one section, which matters because a
  // full pass is several minutes of software rasterisation.
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',')) : null;
  const wanted = (section) => !only || only.has(section);

  try {
    const viewport = { width: 1440, height: 810 };
    const page = await browser.newPage();
    await page.setViewport(viewport);
    page.on('pageerror', (e) => console.warn('  [page error]', e.message));

    if (wanted('carousel')) {
    console.log('carousel');
    for (const id of CAROUSEL) {
      await loadExample(page, base, id);
      await shoot(page, sharp, path.join(OUT_DIR, `carousel-${id}.jpg`), {
        width: 1140, height: 534, crop: centredCrop(viewport, 1140 / 534),
      });
    }
    }

    if (wanted('views')) {
    console.log('field views');
    await loadExample(page, base, VIEW_SCENE);
    for (const view of VIEWS) {
      await setView(page, view);
      await shoot(page, sharp, path.join(OUT_DIR, `view-${view}.jpg`), {
        width: 680, height: 300, crop: centredCrop(viewport, 680 / 300, 0.92, 0.72),
      });
    }
    }

    if (wanted('categories')) {
    console.log('category tiles');
    for (const [category, id] of Object.entries(CATEGORY_TILES)) {
      await loadExample(page, base, id);
      await shoot(page, sharp, path.join(OUT_DIR, `category-${category}.jpg`), {
        width: 300, height: 300, crop: centredCrop(viewport, 1, 0.6),
      });
    }
    }

    if (wanted('thumbnails')) {
    console.log('gallery thumbnails');
    for (const example of EXAMPLE_SCENES) {
      await loadExample(page, base, example.id);
      await shoot(page, sharp, path.join(OUT_DIR, `thumbnail-${example.id}.jpg`), {
        width: 500, height: 500, crop: centredCrop(viewport, 1, 0.6),
      });
    }
    }

    if (wanted('tasks')) {
    console.log('assignment thumbnails');
    if (!fs.existsSync(path.join(DIST, 'tasks'))) {
      console.error('  dist/tasks is missing. Run `npm run build-tasks` first.');
    } else {
      fs.mkdirSync(TASKS_OUT_DIR, { recursive: true });
      for (const task of waveTasks()) {
        const stage = await loadTaskPage(page, base, task.id);
        // The whole stage, letterboxed into the square the gallery asks for,
        // rather than a square cut out of it. An assignment is composed across
        // the width it is set in — the thing to change at one end, the mark to
        // hit at the other — so a crop that keeps only the middle would leave
        // out what the assignment is about.
        await shoot(page, sharp, path.join(TASKS_OUT_DIR, `thumbnail-${task.id}.jpg`), {
          width: 500, height: 500, crop: stage, fit: 'contain',
        });
      }
    }
    }

    if (wanted('tools') || wanted('favicon')) {
      // The hand-composed scenes are written in square coordinates, so the
      // page is square for them.
      await page.setViewport(TOOL_VIEWPORT);
    }

    if (wanted('tools')) {
      console.log('tool icons');
      for (const [type, scene] of Object.entries(TOOL_SCENES)) {
        await loadScene(page, base, {
          ...scene, width: TOOL_VIEWPORT.width, height: TOOL_VIEWPORT.height,
        });
        await shoot(page, sharp, path.join(OUT_DIR, `tool-${type}.jpg`), {
          width: 240, height: 240,
        });
      }
    }

    if (wanted('favicon')) {
      console.log('favicon');
      await loadScene(page, base, {
        ...FAVICON, width: TOOL_VIEWPORT.width, height: TOOL_VIEWPORT.height,
      });
      const shot = await page.screenshot({ type: 'png' });
      for (const size of FAVICON_SIZES) {
        const out = path.join(OUT_DIR, `favicon-${size}.png`);
        await sharp(shot)
          .extract(FAVICON.crop)
          .resize(size, size, { fit: 'cover' })
          .png()
          .toFile(out);
        console.log('  wrote', path.relative(ROOT, out));
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
