# Webcam Eye-Tracking Demo — Specification

## Purpose

Build a cross-platform, local browser app that estimates where a user is looking from an ordinary webcam and displays a light blob at the estimated point within the app. This is an experimental demo, not a medical-grade or dependable assistive input device.

## User story

As a laptop or desktop user, I can start the app in Chrome, grant camera access, calibrate it to my gaze, and see a smoothed light blob move within the app toward the point I am looking at.

## Decisions

### Product scope

- The gaze indicator is confined to the app's content area. An optional fullscreen mode can expand the usable area; the app does not track browser chrome or other applications.
- Version one is visual feedback only. It does not move the operating-system pointer, click, select, or control other applications.
- The tracking result is an approximate consumer-webcam estimate. It is not intended for medical use or reliable accessibility control.
- The target is laptop and desktop use on macOS, Windows, and Linux, with an ordinary integrated or USB webcam. Mobile is out of scope.

### Runtime and privacy

- Deliver a small browser app served from the local machine, with a simple launch command and no backend.
- Target current stable Chrome on macOS, Windows, and Linux only.
- Run face/eye inference in the browser on the user's device. No video, landmarks, or gaze coordinates are uploaded or recorded.
- Bundle runtime and model assets locally. After setup, the app must track without an internet connection and must not fetch runtime assets from a CDN.
- Do not persist calibration between sessions. Keep it in memory for the active session only.

### Tracking experience

- Use a guided nine-point calibration at the start of each session, taking roughly 20 seconds, and provide a way to recalibrate.
- Show a small camera preview while the user aligns the camera and calibrates. Hide it by default while tracking.
- Provide explicit start/stop controls and a camera selector.
- Smooth the marker lightly to reduce jitter while keeping it responsive.
- Show a soft-glow, light-colored marker inside the app's active content area.
- The app requires a visible face, an ordinary webcam, and reasonable lighting; accuracy can vary with camera placement, lighting, and user position.

### Implementation direction

Use a locally bundled MediaPipe face-and-iris landmark model, with a per-session calibration mapping from observed eye/face features to app coordinates. This is an implementation choice for the prototype, not a requirement to expose a particular model API to users.

## Acceptance criteria

1. The app launches from a local server and can be opened in current stable Chrome on macOS, Windows, and Linux.
2. After dependencies/assets are set up, the app completes its tracking flow without an internet connection or external network requests.
3. The user can select a camera, start and stop the camera, see a setup/calibration preview, and complete guided nine-point calibration.
4. With valid eye/face landmarks, the marker moves within the app viewport according to the calibrated gaze estimate and is lightly smoothed.
5. Fullscreen mode, when used, expands the calibrated app area; the marker never targets browser chrome or other applications.
6. Camera frames, landmarks, gaze coordinates, and calibration are not uploaded, recorded, or persisted between sessions.
7. The app provides clear guidance for unavailable camera access, missing face/eyes, and calibration/recalibration.
8. The app has no gaze-click or system pointer control.

## Testing seam

Use one app-boundary seam: exercise the start → calibration → tracking → stop flow with a deterministic fake camera/landmark source. Verify that known synthetic gaze inputs move the visible marker within the app area, and that no external network requests or persistent session data are used. Separately perform a manual smoke test in Chrome with a real webcam to check camera permissions, setup, and approximate real-world gaze behavior.

## Out of scope

- System-wide gaze overlays or OS pointer control.
- Gaze-based clicking, selection, or typing.
- Medical, clinical, or assistive-grade accuracy guarantees.
- Mobile browser support.
- Cloud processing, accounts, recording, analytics, or cross-session calibration storage.
