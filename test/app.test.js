import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createEyeTrackerApp } from '../src/app.js';

const pageMarkup = await readFile(new URL('../index.html', import.meta.url), 'utf8');

function setLandmark(landmarks, index, x, y) {
  landmarks[index] = { x, y, z: 0 };
}

function landmarksForGaze(x, y) {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const irisX = 0.24 + x * 0.52;
  const irisY = 0.25 + y * 0.5;
  const eyeWidth = 0.2;
  const eyeTop = 0.39;
  const eyeHeight = 0.04;

  // Face Mesh's refined iris points are 468–477. Eye contours provide a
  // stable local coordinate system for the synthetic test camera.
  setLandmark(landmarks, 33, 0.2, 0.41);
  setLandmark(landmarks, 133, 0.4, 0.41);
  setLandmark(landmarks, 159, 0.3, eyeTop);
  setLandmark(landmarks, 145, 0.3, eyeTop + eyeHeight);
  setLandmark(landmarks, 362, 0.6, 0.41);
  setLandmark(landmarks, 263, 0.8, 0.41);
  setLandmark(landmarks, 386, 0.7, eyeTop);
  setLandmark(landmarks, 374, 0.7, eyeTop + eyeHeight);

  const leftIrisX = 0.2 + irisX * eyeWidth;
  const rightIrisX = 0.6 + irisX * eyeWidth;
  const irisYPosition = eyeTop + irisY * eyeHeight;
  for (let index = 468; index <= 472; index += 1) {
    setLandmark(landmarks, index, leftIrisX, irisYPosition);
  }
  for (let index = 473; index <= 477; index += 1) {
    setLandmark(landmarks, index, rightIrisX, irisYPosition);
  }

  return landmarks;
}

async function waitForState(document, expectedState) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (document.querySelector('#app-root').dataset.state === expectedState) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(document.querySelector('#app-root').dataset.state, expectedState);
}

function setupApp({ landmarkForCurrentGaze = () => landmarksForGaze(0.5, 0.5), cameraError } = {}) {
  const dom = new JSDOM(pageMarkup, { url: 'http://localhost:8000/' });
  const { document, localStorage } = dom.window;
  const video = document.querySelector('#camera-preview');
  Object.defineProperty(video, 'videoWidth', { configurable: true, value: 640 });
  Object.defineProperty(video, 'videoHeight', { configurable: true, value: 480 });
  video.play = async () => {};

  let now = 0;
  let nextFrameId = 0;
  let streamStopped = false;
  let getUserMediaCalls = 0;
  let fetchCalls = 0;
  dom.window.fetch = (...args) => {
    fetchCalls += 1;
    return Promise.reject(new Error(`Unexpected network request: ${args[0]}`));
  };
  const pendingFrames = new Map();
  const stream = {
    getTracks: () => [{ stop: () => { streamStopped = true; } }],
  };

  const mediaDevices = {
    getUserMedia: async () => {
      getUserMediaCalls += 1;
      if (cameraError) throw cameraError;
      return stream;
    },
    enumerateDevices: async () => [
      { kind: 'videoinput', deviceId: 'fake-camera', label: 'Synthetic webcam' },
    ],
  };

  class FakeFaceMesh {
    setOptions(options) {
      this.options = options;
    }

    onResults(callback) {
      this.onResult = callback;
    }

    async send() {
      this.onResult({ multiFaceLandmarks: [landmarkForCurrentGaze()] });
    }

    async close() {}
  }

  const app = createEyeTrackerApp({
    document,
    window: dom.window,
    mediaDevices,
    createFaceMesh: () => new FakeFaceMesh(),
    requestAnimationFrame: (callback) => {
      const id = ++nextFrameId;
      pendingFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => pendingFrames.delete(id),
    now: () => now,
  });

  async function advanceFrame(milliseconds = 200) {
    const first = pendingFrames.entries().next().value;
    assert.ok(first, 'the app should have scheduled a camera frame');
    const [id, callback] = first;
    pendingFrames.delete(id);
    now += milliseconds;
    await callback(now);
    await Promise.resolve();
  }

  return {
    app,
    document,
    localStorage,
    advanceFrame,
    getUserMediaCalls: () => getUserMediaCalls,
    isStreamStopped: () => streamStopped,
    fetchCalls: () => fetchCalls,
    close: () => dom.window.close(),
  };
}

test('user can start, calibrate, track a synthetic gaze, and stop without storing or uploading session data', async () => {
  let gaze = { x: 0.5, y: 0.5 };
  const harness = setupApp({ landmarkForCurrentGaze: () => landmarksForGaze(gaze.x, gaze.y) });
  const { app, document } = harness;

  try {
    app.attach();
    document.querySelector('#start-camera').click();
    await waitForState(document, 'ready');

    assert.equal(harness.getUserMediaCalls(), 1);
    assert.equal(document.querySelector('#camera-preview').hidden, false);

    document.querySelector('#begin-calibration').click();
    assert.equal(document.querySelector('#app-root').dataset.state, 'calibrating');

    let frameCount = 0;
    const visitedTargets = new Set();
    while (document.querySelector('#app-root').dataset.state === 'calibrating' && frameCount < 120) {
      const target = document.querySelector('#calibration-target');
      gaze = { x: Number(target.dataset.x), y: Number(target.dataset.y) };
      visitedTargets.add(`${gaze.x},${gaze.y}`);
      await harness.advanceFrame(200);
      frameCount += 1;
    }

    assert.equal(visitedTargets.size, 9);
    assert.equal(document.querySelector('#app-root').dataset.state, 'tracking');
    assert.equal(document.querySelector('#begin-calibration').disabled, true);
    assert.equal(document.querySelector('#recalibrate').hidden, false);
    assert.equal(document.querySelector('#camera-preview').hidden, true);
    assert.equal(document.querySelector('#calibration-target').hidden, true);

    gaze = { x: 0.25, y: 0.75 };
    for (let index = 0; index < 12; index += 1) {
      await harness.advanceFrame(100);
    }

    const marker = document.querySelector('#gaze-marker');
    const markerX = Number.parseFloat(marker.style.left);
    const markerY = Number.parseFloat(marker.style.top);
    assert.ok(markerX > 10 && markerX < 45, `expected marker x in the left half, got ${markerX}%`);
    assert.ok(markerY > 55 && markerY < 95, `expected marker y in the lower half, got ${markerY}%`);
    assert.equal(marker.hidden, false);

    document.querySelector('#recalibrate').click();
    assert.equal(document.querySelector('#app-root').dataset.state, 'calibrating');
    assert.equal(document.querySelector('#camera-preview').hidden, false);

    document.querySelector('#stop-camera').click();
    await waitForState(document, 'idle');
    assert.equal(document.querySelector('#camera-preview').hidden, true);
    assert.equal(marker.hidden, true);
    assert.equal(harness.isStreamStopped(), true);
    assert.equal(harness.localStorage.length, 0);
    assert.equal(harness.fetchCalls(), 0);
  } finally {
    await app.stop();
    harness.close();
  }
});

test('camera denial is surfaced as actionable status without leaving a running session', async () => {
  const harness = setupApp({ cameraError: new Error('NotAllowedError') });
  try {
    harness.app.attach();
    harness.document.querySelector('#start-camera').click();
    await waitForState(harness.document, 'error');
    assert.equal(harness.document.querySelector('#app-root').dataset.state, 'error');
    assert.match(harness.document.querySelector('#status-message').textContent, /camera permission/i);
    assert.equal(harness.document.querySelector('#camera-preview').hidden, true);
  } finally {
    await harness.app.stop();
    harness.close();
  }
});
