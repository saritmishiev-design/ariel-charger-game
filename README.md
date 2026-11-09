# Ariel's '79 Charger — 700 HP

A mobile-first, physics-based 3D driving game (PWA). A 1979 Dodge Charger with a built 700 hp Hemi,
5-speed manual, clutch pedal, tilt steering and a fully synthesised V8 soundtrack — plus a tuned 800 hp
Nissan GT-R and a 2023 Nissan Sentra, three tracks and a pre-race tuning garage.

**Play:** open the GitHub Pages URL on the phone → browser menu → **Add to Home Screen** → launch from the icon (full-screen, landscape, works offline).

## Features
- **Pre-race garage:** pick the **track** (Classic Track, Nürburgring Lite, 1/4 Mile Drag Strip) and the **car**, then
  toggle four tunes — **Forced induction** (stock / twin turbo), **Final drive** (short / stock / long),
  **Tyres** (street / racing slicks), **Suspension** (stock / lowered: body drops 45 mm, lower CoG, stiffer springs,
  far less roll). Performance bars (power, acceleration, top speed, grip, with a tick at stock) update instantly from
  the same physics spec the car drives with (js/cars.js).
- **Engine builder for every car** (🔧 in the garage): bore, stroke, compression, cylinders, layout, induction and
  boost (to 60 psi), gearbox and ratios, tyres — plus **build tiers** (Stock block / Forged / Race / Pro Mod billet:
  block strength, breathing, knock limit, rev ceiling, anti-lag) and quick builds up to a **3,000+ hp Pro Mod swap**.
  Big-power cars get stiffer springs automatically, and **Drag slicks** give the bite for violent launches.
- **Lenco planetary gearbox:** clutch-pack shifts in 0 ms with no lift and no ignition cut. Also a heavy-duty drag box.
- **Things break:** too much cylinder pressure for the block, detonation (extreme boost on low-octane builds),
  bouncing off the limiter too long or a money-shift over-rev **blows the engine** (bang, fireball, black smoke,
  no restart until RESET). Launch torque beyond the gearbox's rating **shreds the transmission** (no drive, the engine
  revs free). The garage and dyno warn you; a HUD gauge shows engine and gearbox strain while driving.
- **Billboards** show the spawned car's tuned power ("Enjoy the 3,062HP!") — and in the Sentra they admit
  "Wait... this IS a Nissan Sentra. Never mind."
- **Cars:** 1979 Dodge Charger (RWD, 700 hp blown Hemi, drift-happy); Nissan GT-R R35 tune (AWD, 800 hp 3.8 L V6
  twin-turbo, DCT, ~1.7 g grip, launches to 100 in ~3.4 s, V6 voice with turbo whistle and blow-off flutter);
  2023 Nissan Sentra SV (FWD, 149 hp 2.0 L inline-4, CVT-style automatic, all-season tyres, heavy understeer,
  quiet economy muffler). Drive layout is modelled in the drivetrain: driven-axle load, wheelspin eating the
  driven axle's lateral grip (power oversteer RWD / power understeer FWD), brakes split by axle, hand brake on the rears.
- **Tracks:** *Classic Track* (the original). *Nürburgring Lite*: 7.4 km over ~70 m of hills (grades to 12 %,
  crests, a hairpin valley, a Karussell, a 1.75 km straight) on a cannon heightfield with a cambered, terrain-following
  road. *1/4 Mile Drag Strip*: stage behind the line, the Christmas tree counts down, red light if you jump it;
  millisecond ET (interpolated between physics steps), reaction time, 60 ft / 330 ft / 1/8 / 1000 ft splits, trap speed,
  a timing tower, and best ET per car.
- **Real dimensions:** 5.48 m long, 2.92 m wheelbase, 1.96 m wide, 1,770 kg, 56/44 front weight, low CoM, soft '70s springs.
- **Drivetrain sim:** torque curve peaking at 910 Nm / 700 hp @ 6,200 rpm, engine inertia, idle governor, rev limiter,
  friction clutch (slip, bite point, stalling), 5-speed (2.95 / 1.94 / 1.34 / 1.00 / 0.80, 3.23 axle, 316 km/h top speed),
  rear axle with Pacejka-style tyre slip → wheelspin, power oversteer and rear lock-ups (no ABS).
- **Power slides:** flooring it in 1st or 2nd breaks the rears loose (torque kick near the soft limiter), the
  rear steps out progressively and can be held with throttle and counter-steer; traction control allows the
  slide but trims power if it gets too big. Billowing, sun-shaded 3D tyre smoke pours off the rear tyres.
- **Physics:** cannon-es raycast vehicle, fixed 120 Hz step, aero drag, rolling resistance, grass/verge grip,
  stable (slightly understeering) grip balance, frictionless barriers the car slides along, anti-stall after impacts.
- **Controls:** analog GAS / BRAKE / CLUTCH pedals, draggable H-pattern Hurst shifter (or tap a gear), gyro steering
  (DeviceOrientation, either landscape direction, ±4° deadzone, progressive curve to full lock at 32°, light smoothing,
  turn-in assist; a comfortable 15° tilt takes the tightest hairpin; at speed the lock is capped near the tyres' grip so big inputs can't spin the car), touch-slider fallback, haptics.
- **Audio (Web Audio + AudioWorklet):** 8 combustion pulses per cycle in Hemi firing order 1-8-4-3-6-5-7-2 feeding two
  deliberately mismatched exhaust banks (level, pulse shape, pipe resonance, path delay) so the uneven cross-plane
  rhythm survives a mono phone speaker, throat formants, asymmetric saturation, pipe waveguides, load-dependent muffler, saturation, big-cam idle lope,
  overrun crackle, limiter misfires, supercharger whine, intake roar, gear whine, tyre squeal, wind, starter, clunks & grinds.
- **Classic Track:** "Ariel Raceway", a 3.6 km closed circuit with an 800 m main straight, fast sweepers, a tight chicane,
  a 430 m back straight, a heavy-braking hairpin, esses and a final hairpin. Lap timer with best-lap memory per car.
- **Graphics:** PBR materials (two-layer flaked metallic paint with clear coat, chrome, Fresnel glass, cabin interior),
  image-based lighting from a procedural sky with drifting clouds, warm low sun with soft PCF shadows that follow the car,
  contact shadow, procedural asphalt (aggregate, rubbered racing line, tar snakes, braking-zone skid marks), anti-tiling
  grass, swaying 3D grass tufts, two kinds of instanced trees with distance LOD, a forest belt and layered snowy ridges.
  **Battery saver** in the menu lowers resolution, shadow detail and scenery density.
- **For Ariel, from Sarit:** "Love, your wife Sarit" billboards beside the fast sections, bold yellow "Nissan Sentra"
  boards in the heavy braking zones of the slow corners, a 7-second lap-complete banner and a pause screen message.
- **Engine builder & dyno (Charger, from the garage):** build the engine (bore, stroke, compression, 4/6/8/10/12 cylinders, V / boxer / inline),
  forced induction (NA, turbo with lag and blow-off, Roots blower, twincharged, boost level, knock limit),
  gearbox (manual H-pattern, automatic, sequential DCT, air-shifted drag box; every ratio and the final drive)
  and tyres (front/rear width, diameter: grip, balance, gearing and the 3D wheels). The dyno plots the
  power/torque curves live; RUN SIMULATION does a dyno pull and a drag-strip run with the real drivetrain
  (0-100, 0-200, ¼ mile, top speed). The same model (js/build.js) drives the car on track: torque curve,
  redline/limiter, inertia, friction, weight and distribution, shift behaviour, grip, tach and engine sound.
- **Launch control:** hold BRAKE + GAS at a standstill in 1st → 3,500 rpm two-step; release the brake and a
  closed-loop clutch/throttle keeps the rears at peak slip (0-100 km/h ≈ 4.2 s vs ≈ 5.6 s dumping the clutch).
  Hard launches (and nitrous starts) lift the front wheels for a moment.
- **E-BRAKE:** hold to lock the rear axle (clutch opens automatically, no stall) and swing into a hairpin.
- **Sense of speed:** above 120 km/h the FOV widens, the screen edges blur and the camera buzzes gently.
- **Tyre audio:** procedural cornering squeal (pitch follows slip angle) and wheelspin/lock-up howl (pitch
  follows the tyre's rub speed), mixed with the V8.
- **Nitrous:** tap **NOS** to arm, floor the gas to spray (+55 % torque, 3.5 s bottle, refills in 20 s) with exhaust
  flames, radial speed blur, FOV kick and hiss.
- **HUD:** lap progress bar with distance to the finish; camera button cycles **Chase / Cockpit / Hood**.
- **PWA:** `manifest.json` (fullscreen, landscape) + service worker with offline precache.

## Driving
1. In the garage pick a track, a car and the tunes, then tap **RACE** (allow motion access on iPhone). Hold the phone like a steering wheel. **CENTER** re-zeros the tilt. From the pause menu, **GARAGE · CAR & TRACK** goes back.
2. Hold **CLUTCH**, drag the knob (or tap) into **1**, add a little **GAS** and slowly lift the clutch.
3. Shift: lift, clutch in, move the knob, clutch out. Without the clutch the box grinds unless the revs match.
4. Traction control is on by default; turn it off in the menu for raw power. **Auto-clutch** hides the clutch pedal
   (the GT-R's DCT and the Sentra's automatic always shift themselves: ▲/▼ paddles, R ← N → D on the automatic).
5. Drag strip: you start staged; select a gear and wait for the green (BRAKE + GAS holds launch control). **RESET** re-stages.

Keyboard (desktop testing): W/S/A/D or arrows, Space = clutch, 1-5 / R / N, I = ignition, C = camera, X = NOS, H = hand brake, T = reset, Esc = menu.

## Run locally
Any static server works (the service worker and motion sensors need `localhost` or HTTPS):
```bash
python3 -m http.server 8080   # then open http://localhost:8080
```

## Project layout
```
index.html, css/style.css      UI shell, HUD, pedals, shifter, menu
js/main.js                     bootstrap, loop, camera, laps, drag timing, menus
js/config.js                   Charger spec & tuning
js/cars.js, pregame.js         car line-up, tracks, lite tunes → physics spec, performance bars, pre-race garage UI
js/drivetrain.js               engine / clutch / gearbox / driven-axle model
js/build.js, garage.js         garage build → engine model & spec, dyno + drag-strip sim, garage UI
js/vehicle.js                  cannon-es raycast vehicle + steering, brakes, aero
js/carModel.js, bodies.js      procedural 3D Charger (extruded) and lofted GT-R and Sentra, wheels, wheel wells
js/track.js                    the three tracks: road, terrain/heightfield, curbs, barriers, stands, drag-strip tree
js/scenery.js                  trees, grass tufts, mountains, billboards, LOD
js/sky.js, textures.js         sky dome + environment map, procedural textures
js/merge.js                    draw-call merging helper
js/audio.js, engine-worklet.js engine & effects audio
js/controls.js, hud.js, effects.js
vendor/                        three.js r160, cannon-es 0.20 (MIT)
manifest.json, sw.js, icons/   PWA
tools/make-icons.mjs           regenerates the PNG icons
```
When you change files, bump `VERSION` in `sw.js` and `BUILD` in `js/config.js`. The service worker is network-first,
so installed copies pick up a new build on the next launch; the build number shows under the menu title.

**iPhone tip:** if there's no sound, flip the ring/silent switch off (iOS mutes web audio in silent mode on older versions).
