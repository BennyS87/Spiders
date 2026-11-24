# Spiders

A spectral resampler for Mac and Windows. Import a sound and Spiders slices it into frames, measures the timbre of each one, groups similar frames together and spins them into a map of cells you can play. Play cells with the mouse, your computer keyboard or a MIDI keyboard, record loops and melodies onto tracks, add effects, then save the project or export the tracks.

Spiders sits alongside Reel Studio and Orbit and uses the same effects.

![Spiders icon](build/icon.png)

## Using Spiders

| To | Do this |
|---|---|
| Import sounds | **+ Import** (⌘I), or drop WAV, MP3, AIFF, FLAC, OGG, M4A or MIDI files on the window. A project can hold as many sounds as you like. MIDI files are played through built-in sounds first, then mapped like audio. |
| Try it without a file | **Try the demo sound** on the welcome screen. |
| Read the map | Every cell is one frame (a slice of the sound). The colour is its timbre group, ordered dark (violet) to bright (amber). The shape inside each cell is that frame's spectrum: lows at the top, going round clockwise. Brighter cells are louder. In **Web** layout each group gets a wedge and time spirals out from the centre; in **Map** layout similar sounds sit close together. |
| Play frames | Click a cell, or drag across the map to strum through cells. Click or drag along the strip under the map to play the sound in time order. |
| Change how the sound is sliced | In the **Slicing** panel on the left: **Transients** cuts where each new sound starts (set **Sensitivity** and the **Longest** frame). **Grid** gives equal slices. **Beats** slices in time with the project tempo. **Timbre groups** sets the number of groups, or leaves it on Auto. The map redraws on its own after a change. |
| Cells mode (play the sound as a landscape) | Choose **Cells** at the top right of the map, or under **Layout**. Spiders cuts the sound into fine 60 ms frames and lays them out so that similar timbres crowd together into small cells, while unusual sounds sit apart in big cells of their own. The track switches to **Spectral** playback: press anywhere and the sound at that point is held as a steady texture, with no attack. Drag and it flows smoothly from cell to cell. |
| Spectral playback | **Sound** tab, **Playback: Spectral**. It works in every layout, and from pads, keys and MIDI as well as the map. **Spread** blends neighbouring cells (low is precise, high is a smooth blur). **Glide** sets how quickly the sound flows to a new point. **Tilt** brightens or darkens. **Texture** loosens the phase for a breathier hold. **Shimmer** makes partials flicker. **Width** spreads it in stereo. **Quality** is Clean or Lo-fi, and **Pitch** shifts it in the frequency domain. When you record, your drag path is recorded and played back. |
| Edit a single cell | Right-click a cell (or double-click it) and choose **Edit cell…**. Drag the pink edges to change how much of the sound the cell uses, or drag inside to move the snippet. Set the cell's own gain, pitch and direction, and add effects that only this cell goes through, before the track's effects. Edits apply wherever the cell plays: map, pads, keys and notes already recorded. Edited cells have a small ring on the map. **Reset cell** removes the edits. |
| Manual cells | **Slicing: Manual**. Drag along the strip under the map to cut a cell, drag a cell's edge to resize it, and right-click a cell to edit or delete it. Switching to Manual starts you off with the current cells, and **Clear all cells** starts you from scratch. The map updates after each change. |
| Put frames on pads | Each track has 40 pads, laid out like your keyboard: 1–0, Q–P, A–;, Z–/. Drag a cell out of the map onto a pad, or press **Assign from map** and click cells one after another. **Fill pads…** fills them for you: one per timbre group, in time order, loudest first, dark to bright, or at random. |
| Play pads | Computer keys, a click on the pad, or a MIDI keyboard. Pads start at C2 (MIDI note 36) and go up a semitone at a time. **Learn MIDI note** sets any pad to any key. |
| Play one frame as an instrument | Switch the track to **Melodic** on the Pads tab and click a cell. Keys A W S E D F T G Y H U J K play it chromatically, and Z and X change octave. On a MIDI keyboard, middle C plays it at its own pitch. |
| Shape the sound | **Sound** tab: **One shot**, **Gate** or **Loop** playback, Forward or Reverse, Gain, Pitch, Fine, Attack, Release, Length (how much of the frame plays), Scatter (the chance each hit swaps in another frame from the same group), and Velocity. |
| Add effects | **Effects** tab: EQ (drag the points), Filter, Compressor, Saturation, Distortion, Phaser / Flanger / Chorus, Echo, Reverb, Trance Gate and Vocoder. These are the same effects as Reel Studio and Orbit. They run top to bottom; use ↑ ↓ to reorder, the switch to bypass, and × to remove. |
| Record | Select a track (it says **ARMED**), press **Record** (⌘R) and play. Recording loops round the highlighted bars and adds to what's there on each pass. **Record quantize** snaps what you play to the grid. Press Record again to stop recording; the music keeps playing. ⌘Z undoes a whole take. |
| Edit the timeline | Drag notes to move them, including onto other tracks. Drag a note's right edge to change its length. Alt-drag copies notes. Drag on empty space to select several notes. Double-click an empty spot to place the selected frame. Right-click a note to change its pitch, delete it or show it in the map. Delete removes notes, ⌘D duplicates them, ⌘C and ⌘V copy and paste, and **Quantize** (⌘U) snaps them to the grid. |
| Loop and move around | Click the ruler to move the playhead. Drag along the ruler to set the loop, or choose a length from **Loop**. Space plays and stops, and Enter goes back to the start. |
| Tracks | **+ Track** (⌘T) adds a track. A new track starts with a copy of the current track's pads. Every track can use any sound, and a sound can be used on any number of tracks. Track headers have mute, solo, volume and pan. Right-click a header to rename, duplicate or delete the track. |
| Save | **Save** (⌘S) writes a `.spiders` file. Your sounds are stored inside it, so the file opens anywhere. On Mac, double-click a `.spiders` file to open it in Spiders. |
| Export | **Export** (⌘E): **the full mix**, **each track as its own file** (you choose a folder), **only the selected track**, or **MIDI notes**. You can export the whole song or the loop region, repeated up to 32 times. Choose how it ends: let echoes and reverb ring out, make a seamless loop, or cut off at the end. Choose WAV (44.1 kHz, 16-bit) or MP3. |
| Save single frames | Right-click a cell: **Export this frame as WAV** or **Export all of group N as WAV**. |

## Building with GitHub (no Xcode needed)

GitHub Actions builds the apps on GitHub's own Mac and Windows machines, so you don't need to install anything on your computer. This works the same way as Orbit.

1. Create a new **empty** repository on GitHub, for example `spiders`.
2. Push this folder to it:
   ```bash
   cd Spiders
   git init
   git add .
   git commit -m "Spiders 1.0.0"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/spiders.git
   git push -u origin main
   ```
   (Or use GitHub Desktop and choose *Add Existing Repository* for this folder.)
3. Open the **Actions** tab. The *Build Spiders* workflow builds both apps in about 5–10 minutes. Open the finished run and download them under **Artifacts**:
   - `Spiders-mac`: `Spiders-1.1.0-mac-arm64.dmg` (Apple Silicon) and `Spiders-1.1.0-mac-x64.dmg` (Intel)
   - `Spiders-win`: `Spiders-Setup-1.1.0.exe` (installer) and `Spiders-Portable-1.1.0.exe`
4. **To publish a release** with download links on the repo's Releases page, push a version tag:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
   Bump `"version"` in `package.json` before tagging each new release.

### Opening it the first time

The builds aren't signed with a paid Apple or Microsoft certificate, so both systems warn you the first time you open Spiders:

- **macOS (Sequoia):** Open the app once. Then go to **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to the Spiders message. If macOS says the app is "damaged", run this in Terminal:
  `xattr -dr com.apple.quarantine /Applications/Spiders.app`
- **Windows:** On the SmartScreen prompt, click **More info**, then **Run anyway**.

## Running from source (optional)

You need Node.js 20 or newer:

```bash
npm install
npm start
```

## How the mapping works

1. **Listening:** a short-time Fourier transform (2048-point window) turns the sound into a 40-band mel spectrogram.
2. **Slicing:** frames are cut at onsets (peaks in spectral change, with an adaptive threshold set by Sensitivity), on an even grid, or on beat divisions. Quiet frames are kept on the strip but left off the map. A sound can have up to 1,024 frames.
3. **Measuring timbre:** for each frame, Spiders measures 12 MFCCs plus brightness (spectral centroid), noisiness (spectral flatness), loudness, movement and attack.
4. **Grouping:** k-means++ clusters the frames. In Auto mode it tries 3 to 12 groups and picks the best fit by silhouette score. Groups are ordered from dark to bright.
5. **Spinning the web:** principal component analysis places similar frames close together. A relaxation pass then spreads the frames into even cells, and each cell is drawn as a Voronoi region with its own radial spectrum. In **Cells** layout, t-SNE builds the landscape instead and nothing is evened out, so dense regions get small cells and outliers get big ones.
6. **Spectral voice:** an AudioWorklet phase vocoder reads 2048-sample windows across the chosen cells, blends their magnitudes, and keeps each partial's true frequency from the phase difference between two windows. It then resynthesises a steady, held sound, gliding the spectrum whenever the point moves.

All of this runs in a background worker, so the app stays responsive.

## Project layout

```
main.js / preload.js         Electron main process (window, menus, file dialogs, MIDI permission)
src/index.html, styles.css   UI
src/js/analysis.js           Spectral analysis, slicing, features, clustering, layout (runs in a worker)
src/js/midi-render.js        MIDI file reader and built-in sounds for MIDI import
src/js/effects.js            The effects (EQ, filter, compressor, saturation, distortion, modulation, echo, reverb, trance gate, vocoder)
src/js/spectral.js           Spectral (held) voice: AudioWorklet phase-vocoder freeze, blending and glide
src/js/engine.js             Audio engine: frame and spectral voices, track and cell effect chains, transport, scheduler, offline render
src/js/mapview.js            The cell map and the strip
src/js/timeline.js           Tracks and note editing
src/js/panels.js             Sound library, Pads / Sound / Effects panels
src/js/knob.js               Knob control (shared design with Orbit)
src/js/exporters.js          WAV / MP3 / MIDI writers
src/js/app.js                App state, undo, import, keyboard and MIDI input, recording, files, export
.github/workflows/build.yml  GitHub Actions: Mac + Windows builds and releases
```

MP3 encoding uses [lamejs](https://github.com/zhuker/lamejs) (LGPL-3.0), stored in `src/vendor/`.
