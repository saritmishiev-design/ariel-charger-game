# Ariel's '79 Charger — 700 HP

A mobile-first, physics-based 3D driving game (PWA). A 1979 Dodge Charger with a built 700 hp Hemi,
5-speed manual, clutch pedal, tilt steering and a fully synthesised V8 soundtrack.

**Play:** open the GitHub Pages URL on the phone → browser menu → **Add to Home Screen** → launch from the icon (full-screen, landscape, works offline).

## Features
- **Real dimensions:** 5.48 m long, 2.92 m wheelbase, 1.96 m wide, 1,770 kg, 56/44 front weight, low CoM, soft '70s springs.
- **Drivetrain sim:** torque curve peaking at 910 Nm / 700 hp @ 6,200 rpm, engine inertia, idle governor, rev limiter,
  friction clutch (slip, bite point, stalling), long 5-speed (2.95 / 1.94 / 1.34 / 1.00 / 0.80, 3.23 axle),
  rear axle with Pacejka-style tyre slip → wheelspin, power oversteer and rear lock-ups (no ABS).
- **Physics:** cannon-es raycast vehicle, fixed 120 Hz step, aero drag, rolling resistance, grass/verge grip.
- **Controls:** analog GAS / BRAKE / CLUTCH pedals, draggable H-pattern Hurst shifter (or tap a gear), gyro steering
  (DeviceOrientation, works in either landscape direction), touch-slider fallback, haptics.
- **Audio (Web Audio + AudioWorklet):** 8 combustion pulses per cycle in Hemi firing order 1-8-4-3-6-5-7-2 feeding two
  separate exhaust banks (cross-plane burble), pipe waveguides, load-dependent muffler, saturation, big-cam idle lope,
  overrun crackle, limiter misfires, supercharger whine, intake roar, gear whine, tyre squeal, wind, starter, clunks & grinds.
- **Track:** "Ariel Raceway", a 3.6 km closed circuit with an 800 m main straight, fast sweepers, a tight chicane,
  a 430 m back straight, a heavy-braking hairpin, esses and a final hairpin. Lap timer with best-lap memory.
- **PWA:** `manifest.json` (fullscreen, landscape) + service worker with offline precache.

## Driving
1. Tap **TURN THE KEY** (allow motion access on iPhone). Hold the phone like a steering wheel. **CENTER** re-zeros the tilt.
2. Hold **CLUTCH**, drag the knob (or tap) into **1**, add a little **GAS** and slowly lift the clutch.
3. Shift: lift, clutch in, move the knob, clutch out. Without the clutch the box grinds unless the revs match.
4. Traction control is on by default; turn it off in the menu for raw 700 hp. **Auto-clutch** hides the clutch pedal.

Keyboard (desktop testing): W/S/A/D or arrows, Space = clutch, 1-5 / R / N, I = ignition, C = camera, T = reset, Esc = menu.

## Run locally
Any static server works (the service worker and motion sensors need `localhost` or HTTPS):
```bash
python3 -m http.server 8080   # then open http://localhost:8080
```

## Project layout
```
index.html, css/style.css      UI shell, HUD, pedals, shifter, menu
js/main.js                     bootstrap, loop, camera, laps, menus
js/config.js                   car spec & tuning
js/drivetrain.js               engine / clutch / gearbox / rear axle model
js/vehicle.js                  cannon-es raycast vehicle + steering, brakes, aero
js/carModel.js                 procedural 3D Charger
js/track.js                    circuit, curbs, barriers, scenery
js/audio.js, engine-worklet.js engine & effects audio
js/controls.js, hud.js, effects.js
vendor/                        three.js r160, cannon-es 0.20 (MIT)
manifest.json, sw.js, icons/   PWA
tools/make-icons.mjs           regenerates the PNG icons
```
When you change files, bump `VERSION` in `sw.js` so installed copies update.

**iPhone tip:** if there's no sound, flip the ring/silent switch off (iOS mutes web audio in silent mode on older versions).
