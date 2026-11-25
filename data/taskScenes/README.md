# Task scenes

A *task scene* is an ordinary Ray Optics scene with three extra properties:

| Property      | What it does                                                                    |
|---------------|---------------------------------------------------------------------------------|
| `interaction` | decides what the student is allowed to change, scene-wide and per object         |
| `ui`          | decides which parts of the interface are shown                                   |
| `task`        | states the assignment and the goals that are scored against the simulation       |

They work in the full web app and in the standalone widget. The widget is what you embed in a
course: `npm run build-tasks` turns each scene in this directory into one self-contained HTML file
in `dist/tasks/` with no external references at all, which is what platforms such as edX require.

## Building and previewing

```bash
npm run build-task-editor    # the designer: the full editor, opened on a task scene
npm run build-tasks          # dist/tasks/<scene>.html, one self-contained file per scene
npm run start                # then open /widget/index.html?scene=<name> to iterate on a scene
```

The dev page reads the scene list from `index.json` in this directory, so add new scenes there.

## Designing a task without editing JSON

`npm run build-task-editor` builds the ordinary web app together with a launcher at
`dist/task-editor/`. Serve `dist/` and open it; it lists the scenes in this directory and opens each
one in the editor with `?design=1`.

In that mode the scene's own `interaction` and `ui` settings are read, written and saved as usual but
are **not enforced**, so every object can be selected, moved and edited however the task restricts the
student. Everything the editor already does applies: create objects from the toolbar, drag them,
change their properties in the object bar, undo, and the JSON tab if you want to see the file.

Two things are specific to the designer:

- **Goal targets are handles on the canvas** — the amber dots, with their tolerance as a dashed circle
  and the goal's label next to them. Drag one to place it; the coordinates in the file follow.
- **A "Task" tab** in the sidebar edits everything that is not an object: the task's title,
  description, hint and success message; the list of goals and their fields; the illustration; the
  scene-wide interaction and interface settings; and the interaction settings of whichever object is
  selected. Each interaction and interface key is a three-way choice — *default* leaves the key out of
  the file altogether, which means "allowed".

**File → Save** writes an ordinary scene file. Put it in `data/taskScenes/`, add its name to
`index.json`, and run `npm run build-tasks`. The designer has to be served over HTTP rather than
opened from disk, because the app fetches its translations at runtime.

## `interaction` — what the student may change

Categories, all booleans:

| Key         | Level        | Meaning                                                              |
|-------------|--------------|----------------------------------------------------------------------|
| `enabled`   | scene+object | Wildcard standing for every key the same level does not mention.      |
| `select`    | scene+object | The object can be selected and highlighted.                           |
| `move`      | scene+object | The object can be dragged as a whole.                                 |
| `moveX`     | scene+object | That movement may change the x coordinate.                            |
| `moveY`     | scene+object | That movement may change the y coordinate.                            |
| `reshape`   | scene+object | Its defining points (endpoints, vertices, arc points) can be dragged. |
| `edit`      | scene+object | Its numeric and boolean properties can be edited.                     |
| `remove`    | scene+object | It can be deleted.                                                    |
| `properties`| scene+object | Per-property overrides, see below.                                    |
| `create`    | scene        | New objects can be added.                                             |
| `pan`       | scene        | The view can be panned.                                               |
| `zoom`      | scene        | The view can be zoomed.                                               |
| `keyboard`  | scene        | Keyboard editing shortcuts are active.                                |

A setting is looked up most-specific first: the object's `properties[<name>]`, the object's category
key, the object's `enabled`, then the same three on the scene, and finally the default, which allows
everything. So the usual pattern is to freeze the scene and open up only what the exercise is about:

```json
"interaction": { "enabled": false, "pan": true, "zoom": true }
```

```json
{ "type": "Mirror", "name": "Segment 1", "interaction": { "move": false, "reshape": true } }
```

`properties` gives the finest control. The name is a serialized property of the object
(`focalLength`, `p1`, `brightness`, …), or `part<n>` for a draggable part with no named point. The
same name governs both ways of changing the property: dragging its handle on the canvas and typing
its value in the property panel.

```json
"interaction": { "reshape": false, "properties": { "p2": true } }
```

means only the second endpoint may be dragged, and

```json
"interaction": { "edit": true, "properties": { "focalLength": false } }
```

means everything but the focal length may be edited. An object is selectable whenever it allows
anything else, unless some level states `select` explicitly.

`moveX` and `moveY` refine `move` rather than replacing it, and each falls back to `move` at its own
level before the chain continues to the scene. This is how an element is confined to an optical axis:

```json
"interaction": { "move": true, "moveY": false, "reshape": false }
```

Two things follow from a pinned point that are worth knowing when authoring:

- A control point the student may not move never shows a drag cursor. If the object itself can be
  moved, grabbing that point moves the whole object instead, so the most obvious place to grab an
  object is never dead.
- The ideal lens, the ideal curved mirror, and a spherical lens defined by its focal length put their
  focal points on the canvas as drag handles under the name `focalLength`, so an exercise about focal
  length needs no number box:

  ```json
  { "type": "IdealLens", "name": "Relay",
    "interaction": { "move": true, "reshape": false, "properties": { "focalLength": true } } }
  ```

## Lenses, axes and focal points

### An ideal lens that looks like glass

An ideal lens obeys the lens equation exactly, which is what makes it usable for an exercise: the
image is where the formula says, with no aberration to fight. But a line with two arrowheads does not
look like a lens. `IdealLens` can therefore be drawn as the piece of glass its focal length implies,
while still being traced ideally:

```json
{ "type": "IdealLens", "name": "Objective",
  "p1": { "x": 600, "y": 275 }, "p2": { "x": 600, "y": 525 },
  "focalLength": 160,
  "appearance": "realistic", "curvedSurfaces": "both", "refIndex": 1.9 }
```

| Property         | Meaning                                                                        |
|------------------|---------------------------------------------------------------------------------|
| `appearance`     | `"basic"` (default) or `"realistic"`.                                            |
| `curvedSurfaces` | `"both"` for a symmetric lens, `"front"` or `"back"` for a plano lens.           |
| `refIndex`       | The index the shape is drawn for. Drawing only — it does not affect the rays.    |
| `lensThickness`  | The centre thickness, or 0 to pick one that suits the shape.                     |

The radii come from the lens maker's equation, so the drawing reflects the focal length: shorten it
and the lens gets fatter, make it negative and the lens becomes biconcave. A short focal length over a
tall aperture is a very fast lens and is drawn nearly circular, which is honest — raise `refIndex` if
you want a flatter shape at the same focal length. This is the way to build an imaging exercise: real
single-element lenses at these apertures aberrate far too much to bring an extended object to a
usable focus.

### A real lens given by its focal length

A `SphericalLens` — a real piece of glass, not an idealisation — can be given as a thickness and an
effective focal length instead of radii of curvature. The lens is then symmetric, and the radius
follows from the thick-lens maker's equation, so the focal length is exactly the one asked for:

```json
{ "type": "SphericalLens", "defBy": "DF",
  "p1": { "x": 600, "y": 370 }, "p2": { "x": 600, "y": 430 },
  "params": { "d": 20, "f": 200 }, "refIndex": 1.9 }
```

A negative `f` gives a diverging lens. `d` is the centre thickness: a short focal length over a wide
aperture needs a fat lens, and the object reports a warning when the surfaces would meet before the
rim. Setting `partialReflect` to false keeps the diagram clear of the faint reflections off the glass.

### Reference marks

`IdealLens`, `IdealMirror` and `SphericalLens` each take two reference marks, off by default:

| Property          | What it draws                                                              |
|-------------------|-----------------------------------------------------------------------------|
| `showOpticalAxis` | A dashed line through the element along its axis, across the whole viewport. |
| `showFocalPoints` | The focal points, permanently rather than only while the element is hovered. |

Both are themeable through the scene's `theme.opticalAxis` and `theme.focalPoint`.

## `illustration` — showing the object and its image

A ray diagram says where an image is, not what it looks like. `illustration` draws a picture at the
object and a second one, scaled and flipped by the magnification the simulation actually produces,
at the image:

```json
"illustration": {
  "picture": "church",
  "top": "Tip",
  "bottom": "Base",
  "imageGoals": ["tip", "base"],
  "opacity": 0.9
}
```

`top` and `bottom` name the two light sources that stand for the ends of the object; the picture is
drawn between them. `imageGoals` names two `raysConverge` goals, whose measured convergence points
locate the same two ends of the image — so the second picture follows the rays rather than any
assumption about the optics, and turns upside down exactly when the image does. Leave `imageGoals`
out, or set `showImage` to false, to draw only the object.

## `ui` — what is shown

All booleans, all default to `true`. `toolbar`, `objectBar`, `sidebar`, `statusBar`, `footer` and
`welcomeMessage` are honoured by the full web app; `taskPanel`, `resetButton`, `zoomButtons`,
`playButton`, `viewSelector`, `showTargets`, `showAffordances` and `celebrate` by the widget.

`toolbar`, `objectBar` and `statusBar` are honoured by the wave app too.

`viewSelector` and `playButton` only ever appear on a wave scene, and the play button only in the
two views that show an instant rather than a time average. Both are on by default, because a field
the student can neither switch nor set in motion hides most of what the simulation knows; a figure
meant to be one fixed picture turns them off. Which view that picture is, and whether it moves, are
scene properties: `waveOptics.view` and `waveOptics.animated`.

`showAffordances` is what makes a restricted scene readable: the widget marks every place the
permissions let the student grab, with a ring on each draggable control point and a four-way arrow
at the centre of each object that can be moved. Turn `objectBar` off to make an exercise purely
direct-manipulation, with no number boxes at all. A minimal applet is usually:

```json
"ui": { "toolbar": false, "objectBar": false, "sidebar": false, "statusBar": false }
```

Objects draw their own markers regardless of whether they are interactive — a light source's
direction point, for example. When such a marker would be misleading in a restricted scene, hide it
through the scene's `theme`, which already accepts per-scene overrides:

```json
"theme": { "directionPoint": { "color": { "r": 1, "g": 0, "b": 0, "a": 0 } } }
```

### Glass that is too faint to see

Glass is shaded by its refractive index on a logarithmic scale pinned so that ordinary glass at 1.5
is drawn with a fill of 0.2. A weakly refracting material is therefore drawn very faintly — at an
index of 1.2 the fill is 0.09, which on a black background is close to nothing, and an exercise
about such a material ends up asking the student to drag something they can barely see.
`theme.glass.contrast` scales the whole relation, so the drawing can be made legible without
changing the optics:

```json
"theme": { "glass": { "contrast": 2.2 } }
```

A contrast of `log(1.5) / log(n)` draws an index of `n` with the weight that 1.5 has by default:
2.2 for an index of 1.2, and 1.4 for 1.33. It applies
everywhere an index is shaded — the polygon and curve glasses, the GRIN materials, and the ideal
lens drawn realistically — and it is purely a display setting; no ray is affected.

## `task` — the assignment

```json
"task": {
  "title": "Collimate the lamp",
  "description": "Shown under the title.",
  "hint": "Revealed by a button, so it costs the student something to look.",
  "successMessage": "Shown when every goal is met.",
  "requireAll": true,
  "goals": [ ... ]
}
```

Every goal is scored after each simulation run and reports both whether it is met and how close the
student is, so the panel shows a progress bar that keeps moving while they adjust things. Common
keys on any goal: `id`, `title`, `description`, `weight`, `showTarget`, `targetLabel`, and `source`
(the `name` of a light source, to score only the light from that one).

### `raysThroughPoint`

Rays must pass within `radius` of `point`.

```json
{ "type": "raysThroughPoint", "point": { "x": 420, "y": 560 }, "radius": 25, "count": 6, "minDepth": 1 }
```

`count` defaults to every ray the relevant sources emit. `minDepth` is the number of interactions a
ray must already have had to count, so `1` means "only reflected or refracted light".

### `raysAvoidPoint`

The mirror image: no ray may come within `radius` of `point`. Drawn as a dashed red region.

### `raysConverge`

The rays must come to a focus of at most `radius` across, optionally at a given `point`. Unlike
`raysThroughPoint` this measures the sharpness of the spot, which suits tasks about aberration and
about image position. The measured focus is drawn on the canvas as a cross.

```json
{ "type": "raysConverge", "source": "Tip", "point": { "x": 1240, "y": 270 }, "radius": 20, "minDepth": 2 }
```

### `collimated`

The outgoing light must be parallel to a direction, given as `angle` in degrees or as a `direction`
vector, within `tolerance` degrees.

```json
{ "type": "collimated", "angle": 0, "tolerance": 1.2 }
```

### `detectorPower`

A named `Detector` in the scene must read at least `min`, or `target` within `tolerance`.

```json
{ "type": "detectorPower", "detector": "Screen", "min": 0.8 }
```

### `imageSharpness`

How badly a point of the object is smeared by the time it reaches a named {@link ImageScreen},
measured as the root-mean-square spot radius averaged over the field. `max` is the blur that counts
as sharp enough; `reference` sets how fast the bar fills on the way there and defaults to `max`.

```json
{ "type": "imageSharpness", "screen": "Screen", "max": 5, "reference": 5 }
```

### `imageSize`

The picture on a named screen must come out `target` times life size, within `tolerance`. Any task
about aberration needs this as well as `imageSharpness`: a system with spherical aberration has a
waist well in front of where the picture belongs, and sliding the screen there improves the blur by
shrinking the picture rather than by fixing the optics.

```json
{ "type": "imageSize", "screen": "Screen", "target": 1.4, "tolerance": 0.09 }
```

### `lensPowerSum`

The lenses named in `lenses` — by default every lens in the scene — must add up to `target` in
reciprocal length units, within `tolerance`. This is the constraint that makes an exercise about
distributing power an exercise at all.

```json
{ "type": "lensPowerSum", "lenses": ["Lens 1", "Lens 2"], "target": 0.0034286, "tolerance": 0.00008 }
```

### `objectProperty`

A numeric property of a named object must reach `target` within `tolerance`.

```json
{ "type": "objectProperty", "object": "Relay", "property": "focalLength", "target": 108.75, "tolerance": 2 }
```

## `ImageScreen` — the picture, not just where it is

A ray diagram is a slice through the optical axis. The picture a system forms lies in the plane
perpendicular to that slice, which the diagram never shows, and an exercise about image quality is
about exactly that plane. `ImageScreen` draws it: a bar standing across the axis in the diagram,
carrying the plane it occupies turned towards the viewer, with the picture the system throws on it.

```json
{ "type": "ImageScreen", "name": "Screen",
  "p1": { "x": 1450, "y": 325 }, "p2": { "x": 1450, "y": 575 },
  "panelScale": 1, "showFrame": true, "targetMagnification": 1.4,
  "caption": "what the screen sees" }
```

| Property              | Meaning                                                                 |
|-----------------------|-------------------------------------------------------------------------|
| `p1`, `p2`            | The screen in the diagram. Its length is its real size, both ways.       |
| `panelScale`          | How large the turned-towards-you panel is drawn, 1 being life size.      |
| `showFrame`           | A frame and corner marks, which make it read as a plane seen face on.    |
| `targetMagnification` | Draws a dashed outline of the object at the size the picture should be.  |
| `caption`             | A label under the panel.                                                 |

The object is the scene's `illustration` picture, located by the two light sources it names, so one
`illustration` block serves both the drawing in the diagram and the thing that is imaged. Leave
`imageGoals` out when a scene has a screen: the screen already shows the image, and a second ghost
picture floating in the diagram only competes with it.

### How the picture is produced

The picture is not drawn by the ray tracer the diagram uses, which works in the plane of the page
only. `src/core/imaging/` traces the system in three dimensions instead, sequentially through each
surface of revolution, which is what an optical designer does and the only way to get the skew rays
that carry coma and astigmatism. It traces a spot diagram for a ladder of field heights and stamps
that, rotated and interpolated, once per pixel of the object, so the blur varies across the picture
exactly as the aberrations do. It is geometrical optics throughout: no diffraction, no scattering,
no interference.

Only `SphericalLens`, `IdealLens` and `Aperture` are understood, and only between the object and the
screen. Everything else in the scene is ignored, so rulers, labels and the light sources that draw
the example rays cost nothing. An element that is tilted or off the axis is left out and reported
rather than approximated.

### Where it runs

The scatter — every object point through every pupil point onto the screen — is a few million
additive writes to a float buffer, which is what a GPU is for and what a CPU is worst at. Where
WebGL2 is available with `EXT_color_buffer_float` and `EXT_float_blend`, it is one draw call of a
few million points; `src/core/imaging/webglScreenRenderer.js` does that, and
`src/core/imaging/screenRenderer.js` does the same thing on the CPU wherever it is not. The ray
tracing itself stays on the CPU either way: there are only a few thousand rays, and they are what
the task is scored from.

Two resolutions are rendered rather than one. A coarse picture is drawn while something is being
dragged, and a fine one about a seventh of a second after it stops, so that dragging the screen
through focus keeps up with the hand while the settled picture is the one worth looking at. On an
M1 laptop the coarse pass costs about 10 ms and the fine one about 30 ms; on the CPU fallback the
fine one is nearer 80 ms.

### A lens the student turns by its power and its shape

`SphericalLens` accepts a fourth `defBy`, `"DFX"`, which gives the lens as a thickness, an effective
focal length and a *shape factor* `x = (r2 + r1) / (r2 - r1)`:

```json
{ "type": "SphericalLens", "defBy": "DFX",
  "p1": { "x": 750, "y": 365 }, "p2": { "x": 750, "y": 535 },
  "params": { "d": 28, "f": 291.6667, "x": 0 }, "refIndex": 1.5 }
```

The two radii do not separate how strongly a lens focuses from how it is bent — moving either one
changes both — which makes a lens impossible to reason about one number at a time. These two do:
`f` alone sets the focusing, and `x` alone sets the bending, 0 being equiconvex and ±1 the two
plano-convex orientations.

Such a lens exposes three writable properties, any of which can be put on a slider or named in
`interaction.properties`:

| Property       | What it is                                                                   |
|----------------|-------------------------------------------------------------------------------|
| `power`        | 1000 / f. **Prefer this to `focalLength` in anything a beginner will touch.**  |
| `focalLength`  | The effective focal length.                                                    |
| `shapeFactor`  | The bending, `x`.                                                              |

Focal length is the wrong number to put in front of someone meeting optics for the first time: it
runs backwards, since a stronger lens has a *smaller* one, and two lenses together do not add up in
it. Powers do both correctly, which is the whole reason an exercise about sharing the focusing
between several elements is legible at all. The thousandfold scaling keeps the numbers small; on a
scene drawn in millimetres it is exactly the dioptre.

## `controls` — sliders that are always on screen

Dragging things on the canvas and typing into the object bar assume a student who will poke at a
diagram to find out what is live. Someone looking at their first ray diagram will not: they do not
know the lenses are the parts that matter, or that a lens has a strength that can be changed, and an
object bar that appears only once you have already clicked the right thing is no help. `controls`
puts every adjustable quantity on screen, named, with its range shown by where the handle sits.

```json
"controls": {
  "title": "The three lenses",
  "note": "Watch the steepest angle as you move the sliders.",
  "groups": [
    { "object": "Lens 1", "label": "Lens 1 — front",
      "sliders": [
        { "property": "power", "label": "Focusing power", "min": 0, "max": 3.6, "step": 0.02,
          "help": "Shown as a tooltip." },
        { "property": "shapeFactor", "label": "Shape", "min": -1.5, "max": 1.5, "step": 0.05 }
      ] }
  ],
  "meters": [
    { "source": "maxIncidence", "label": "Steepest angle at the glass", "screen": "Screen",
      "min": 0, "max": 55, "suffix": "°", "decimals": 0, "lowerIsBetter": true }
  ]
}
```

A slider writes straight to the named property of the named object, so it is subject to the same
`interaction.properties` permissions as every other way of changing it — a scene that shows a slider
must also allow that property. When a scene states `controls`, the pop-up object-bar inspector is
suppressed, because two differently-worded ways to change the same number is worse than one.

### `meters` — the read-only half

A meter shows a number the exercise is about but that is not a goal. This is what makes a cause
visible: an exercise about aberration is about how steeply rays meet the glass, and a ray diagram
does not say that out loud unless something puts a number on it.

| `source`        | What it reads                                                              |
|-----------------|-----------------------------------------------------------------------------|
| `maxIncidence`  | The steepest angle, in degrees, at which any traced ray met a glass surface. |
| `imageBlur`     | The RMS spot radius on the named screen, in scene units.                     |
| `imageSize`     | How many times life size the picture is.                                     |
| `lensPowerSum`  | The summed power of `lenses`, in the same units as the `power` property.     |

`min` and `max` set the ends of the bar, `lowerIsBetter` fills it as the value falls, and `target`
with `tolerance` turns it amber when the value drifts off. `suffix` and `decimals` set the
formatting. Everything but `lensPowerSum` is measured by the last screen render, so a meter reads
`—` until the first picture has been drawn.

## Wave optics tasks

A scene holding wave-optics objects (`WavePointSource`, `WaveMultiSlit`, `WaveSquareGrating`,
`WaveZonePlate`, `WaveInterface`, …) is a wave scene: the widget sums fields instead of tracing rays,
and the designer opens it in the wave app. Nothing else changes — the same `interaction`, `ui` and
`task` properties apply, and the same file format is saved.

Wave goals have no rays to count, so each samples the intensity along a probe `line` and asks a
question about the profile. Every measure is a length, a ratio or a count, never an absolute
intensity, so a student never has to match the brightness the author happened to choose.

All of them take `line` (with `p1` and `p2`) and an optional `samples` count.

| Goal | Asks |
|------|------|
| `waveIntensityPeak` | Is the brightest point on the line within `radius` of `point`? `order: 1` picks the second-strongest peak instead of the strongest. |
| `waveFringeSpacing` | Are the fringes `spacing` apart, within `tolerance`? |
| `waveFringeContrast` | Is the visibility `(Imax - Imin) / (Imax + Imin)` at least `min`? |
| `waveSpotSize` | Is the principal peak no wider than `max` at half its height — or `target` within `tolerance`? |
| `waveResolvedPeaks` | Are there exactly `count` peaks, each pair separated by a dip at least `dip` of the way down? |

```json
{ "id": "printed", "type": "waveFringeSpacing",
  "line": { "p1": { "x": 600, "y": -140 }, "p2": { "x": 600, "y": 140 } },
  "spacing": 40, "tolerance": 8, "samples": 561 }
```

The field is sampled on the CPU, propagated through the scene's interfaces, independently of whatever
the GPU is drawing. Scoring therefore does not depend on the display resolution, and a task is scored
correctly even while the adaptive resolution is still climbing.

The four worked examples are all lithography-shaped:

| Scene | What the student changes | What it teaches |
|-------|--------------------------|-----------------|
| `wave_diffraction_orders` | the grating pitch | where a mask's orders land in the pupil, `f λ / p` |
| `wave_numerical_aperture` | the width of the lens pupil | the Abbe limit: no orders captured, no pattern printed |
| `wave_phase_shift_mask` | the bars' transmission and phase | an alternating phase-shift mask prints at half the pitch |
| `wave_zone_plate` | the focal length and the aperture | focus position, and numerical aperture against spot size |

Wave scenes are best authored in the wave app, which the task-designer launcher links to
automatically. Goal targets and probe lines both appear there as draggable handles.

## Embedding

Each file in `dist/tasks/` is a complete page. Upload it as a static asset and point an `<iframe>`
at it, which is the most robust route on a platform that sanitises pasted HTML:

```html
<iframe src="/static/parabolic_by_parts.html" width="100%" height="560" style="border:0"></iframe>
```

To put several applets on a page you control, include the bundle once and mark up each container:

```html
<div data-wave-optics style="height: 520px">
  <script type="application/json"> ... the scene ... </script>
</div>
<script src="wave-optics-widget.js"></script>
```

or create them from code with `WaveOptics.createWidget(element, sceneJson, options)`. The options are
`onTaskStatus(status)`, called after every run with the score of each goal, `onComplete(status)`,
called the first time the task is solved — use them to report progress back to the host page — and
`overrides`, scene properties merged over the scene's own.

Wherever a scene is accepted, a link shared from the simulator is accepted too: the URL its
**File → Copy link** button produces, or the address bar with **Auto sync URL** on, whose hash is
the whole scene compressed. That is the quickest way from a scene on screen to an applet on a page,
with no file in between:

```html
<div data-wave-optics="https://phydemo.app/ray-optics/simulator/#XQAAgAD..." style="height: 520px"></div>
```

## Where an assignment ends up

`npm run build-tasks` writes one self-contained page per scene in this directory to `dist/tasks/`,
and is part of `npm run build`, so the website carries them.

The wave-optics ones are also listed on the gallery page, taking their title and the first sentence
of their description from the scene's own `task`. Their thumbnails are screenshots of the built page
and are committed under `src/img/tasks/`; after adding or reframing a wave assignment, regenerate
them with

```bash
npm run build-app && npm run build-tasks
npm i --no-save puppeteer
node ./scripts/buildWaveImages.mjs --only=tasks
```

A ray-optics scene here is built into a page the same way but is not listed in the gallery, which
leads with wave optics.
