# Gaze — local webcam eye tracker

A small, experimental browser app that estimates gaze from a laptop or USB webcam and renders a soft light blob inside the app. Camera frames are processed locally; the app has no backend and does not save video, landmarks, gaze coordinates, or calibration between sessions.

This is a best-effort demo, not a medical-grade eye tracker or dependable assistive control. Accuracy varies with camera placement, lighting, glasses, and how still you keep your head.

## Requirements

- Node.js 18 or newer and npm, for the one-time local dependency setup
- Current stable Google Chrome on macOS, Windows, or Linux
- An integrated or USB webcam

## Run it

```sh
npm install
npm start
```

Open [http://localhost:8000](http://localhost:8000) in Chrome, allow camera access, choose a camera if needed, and select **Start camera**. Center your face in the preview, then choose **Calibrate gaze** and look at each of the nine targets until it advances. The preview hides when tracking begins. Use **Recalibrate** if your position or camera changes; **Stop** releases the webcam.

The tracking region is the app surface. **Fullscreen** expands that surface; the app never controls the desktop pointer or tracks other windows.

On Windows, if the `npm` command is not on your PATH, install the Node.js LTS release and reopen the terminal. The same `npm install` and `npm start` commands work in PowerShell and Command Prompt.

## Offline and privacy

The first `npm install` needs a network connection to fetch the pinned MediaPipe package. After setup, the app and all MediaPipe model/WASM assets are served from this repository; tracking does not require internet access. The local server only serves the app and its local model assets. A restrictive Content Security Policy blocks app connections to other origins.

Camera access is requested only after you select **Start camera**. Face landmarks and gaze estimates remain in memory for the active session. Stopping the tracker (or closing the page) stops the camera stream and discards calibration. Nothing is recorded, uploaded, or retained between sessions.

## Checks

```sh
npm test
npm run check
```

The app-boundary test uses a deterministic synthetic landmark source to exercise start → nine-point calibration → tracking → stop, including marker movement and the no-network/no-persistent-data expectations. Also test with a real webcam in Chrome; automated synthetic landmarks cannot validate actual camera permissions or real-world gaze accuracy.

## Troubleshooting

- **Camera permission was denied:** use Chrome's site controls to allow camera access for `localhost`, then reload.
- **No camera appears:** connect the webcam and reload; close any other app currently using it.
- **Face or eyes aren't detected:** face the camera, keep both eyes visible, improve lighting, and avoid strong backlighting.
- **The gaze blob is imprecise:** sit at a steady distance, keep your head relatively still, and recalibrate. Consumer webcams provide only an approximate gaze estimate.
- **The local model did not load:** run `npm install` from the repository root and reload the page.

## License notes

The eye-tracking app code is provided for experimentation. MediaPipe Face Mesh is installed from the pinned `@mediapipe/face_mesh` npm package (Apache-2.0); see the package metadata and [MediaPipe Face Mesh documentation](https://google.github.io/mediapipe/solutions/face_mesh) for its license and upstream details.
