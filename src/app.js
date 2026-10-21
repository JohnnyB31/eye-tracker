import {
  averageFeatureVectors,
  extractGazeFeatures,
  fitCalibration,
  smoothPoint,
} from './calibration.js';

export const CALIBRATION_TARGETS = [
  { x: 0.08, y: 0.08 }, { x: 0.5, y: 0.08 }, { x: 0.92, y: 0.08 },
  { x: 0.08, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.92, y: 0.5 },
  { x: 0.08, y: 0.92 }, { x: 0.5, y: 0.92 }, { x: 0.92, y: 0.92 },
];

const TARGET_DWELL_MS = 1800;
const MIN_TARGET_SAMPLES = 6;
const SMOOTHING_ALPHA = 0.32;
const MEDIAPIPE_ASSET_PATH = '/node_modules/@mediapipe/face_mesh/';

function cameraErrorMessage(error) {
  const detail = `${error?.name ?? ''} ${error?.message ?? ''}`.toLowerCase();
  if (detail.includes('notallowed') || detail.includes('permission') || detail.includes('denied')) {
    return 'Camera permission was denied. Allow camera access for this page in Chrome, then try again.';
  }
  if (detail.includes('notfound') || detail.includes('no video')) {
    return 'No camera was found. Connect a webcam and try again.';
  }
  if (detail.includes('notreadable') || detail.includes('in use')) {
    return 'The camera could not be opened. Check that another app is not using it, then try again.';
  }
  return `Could not start the camera${error?.message ? `: ${error.message}` : '.'}`;
}

function defaultFaceMeshFactory(window) {
  const FaceMesh = window?.FaceMesh;
  if (typeof FaceMesh !== 'function') {
    throw new Error('The local face-tracking model did not load. Run npm install, then reload this page.');
  }
  const base = new URL(MEDIAPIPE_ASSET_PATH, window.location.href);
  return new FaceMesh({ locateFile: (file) => new URL(file, base).href });
}

function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

export function createEyeTrackerApp(options = {}) {
  const document = options.document ?? globalThis.document;
  const window = options.window ?? globalThis.window;
  const mediaDevices = options.mediaDevices ?? window?.navigator?.mediaDevices;
  const getUserMedia = options.getUserMedia ?? mediaDevices?.getUserMedia?.bind(mediaDevices);
  const createFaceMesh = options.createFaceMesh ?? (() => defaultFaceMeshFactory(window));
  const requestFrame = options.requestAnimationFrame ?? window?.requestAnimationFrame?.bind(window);
  const cancelFrame = options.cancelAnimationFrame ?? window?.cancelAnimationFrame?.bind(window);
  const now = options.now ?? (() => window?.performance?.now?.() ?? Date.now());

  const root = document?.querySelector('#app-root');
  const trackerCard = document?.querySelector('.tracker-card');
  const surface = document?.querySelector('#tracking-surface');
  const video = document?.querySelector('#camera-preview');
  const marker = document?.querySelector('#gaze-marker');
  const target = document?.querySelector('#calibration-target');
  const status = document?.querySelector('#status-message');
  const warning = document?.querySelector('#face-warning');
  const calibrationBanner = document?.querySelector('#calibration-banner');
  const calibrationStep = document?.querySelector('#calibration-step');
  const progress = document?.querySelector('#calibration-progress');
  const cameraSelect = document?.querySelector('#camera-select');
  const startButton = document?.querySelector('#start-camera');
  const calibrateButton = document?.querySelector('#begin-calibration');
  const recalibrateButton = document?.querySelector('#recalibrate');
  const stopButton = document?.querySelector('#stop-camera');
  const fullscreenButton = document?.querySelector('#fullscreen-toggle');
  const fullscreenExitButton = document?.querySelector('#fullscreen-exit');

  if (!root || !trackerCard || !surface || !video || !marker || !target || !status || !cameraSelect) {
    throw new Error('The eye-tracker page is missing required app elements.');
  }
  if (!startButton || !calibrateButton || !recalibrateButton || !stopButton || !warning || !progress) {
    throw new Error('The eye-tracker page is missing required controls.');
  }

  let state = 'idle';
  let stream = null;
  let faceMesh = null;
  let animationFrameId = null;
  let calibrationIndex = 0;
  let targetStartedAt = 0;
  let targetFeatureSamples = [];
  let calibrationSamples = [];
  let calibrationModel = null;
  let smoothedPoint = null;
  let frameInFlight = false;
  let attached = false;

  function updateControls() {
    const hasCamera = Boolean(stream);
    startButton.disabled = hasCamera || state === 'starting';
    calibrateButton.disabled = !hasCamera || state === 'calibrating' || state === 'tracking';
    recalibrateButton.hidden = state !== 'tracking';
    stopButton.disabled = !hasCamera;
    cameraSelect.disabled = hasCamera || state === 'starting';
    if (state === 'calibrating') calibrateButton.textContent = 'Calibrating…';
    else calibrateButton.textContent = 'Calibrate gaze';
  }

  function setState(nextState) {
    state = nextState;
    root.dataset.state = state;
    updateControls();
  }

  function setStatus(message, kind = 'neutral') {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function clearWarning() {
    warning.hidden = true;
    warning.textContent = '';
  }

  function showWarning(message) {
    if (!warning.hidden && warning.textContent === message) return;
    warning.textContent = message;
    warning.hidden = false;
  }

  function resetCalibrationDisplay() {
    target.hidden = true;
    marker.hidden = true;
    calibrationBanner.hidden = true;
    progress.hidden = true;
    progress.value = 0;
    smoothedPoint = null;
  }

  function renderCalibrationTarget() {
    const point = CALIBRATION_TARGETS[calibrationIndex];
    target.dataset.x = String(point.x);
    target.dataset.y = String(point.y);
    target.style.left = `${point.x * 100}%`;
    target.style.top = `${point.y * 100}%`;
    target.setAttribute('aria-label', `Calibration target ${calibrationIndex + 1} of ${CALIBRATION_TARGETS.length}`);
    calibrationStep.textContent = `Target ${calibrationIndex + 1} of ${CALIBRATION_TARGETS.length}`;
    progress.value = calibrationIndex;
    target.hidden = false;
    calibrationBanner.hidden = false;
  }

  function positionMarker(point) {
    const bounded = { x: clampUnit(point.x), y: clampUnit(point.y) };
    smoothedPoint = smoothPoint(smoothedPoint, bounded, SMOOTHING_ALPHA);
    marker.style.left = `${smoothedPoint.x * 100}%`;
    marker.style.top = `${smoothedPoint.y * 100}%`;
    marker.hidden = false;
  }

  function finishCalibrationTarget(features) {
    calibrationSamples.push({
      features,
      target: CALIBRATION_TARGETS[calibrationIndex],
    });
    calibrationIndex += 1;
    progress.value = calibrationIndex;
    targetFeatureSamples = [];

    if (calibrationIndex >= CALIBRATION_TARGETS.length) {
      calibrationModel = fitCalibration(calibrationSamples);
      if (!calibrationModel) {
        setState('ready');
        target.hidden = true;
        calibrationBanner.hidden = true;
        progress.hidden = true;
        setStatus('Calibration did not produce a stable mapping. Center your face and try again.', 'error');
        return;
      }

      target.hidden = true;
      calibrationBanner.hidden = true;
      progress.hidden = true;
      video.hidden = true;
      marker.hidden = true;
      smoothedPoint = null;
      setState('tracking');
      setStatus('Tracking. Keep your face in view; recalibrate if you move the camera or your seat.', 'success');
      return;
    }

    targetStartedAt = now();
    renderCalibrationTarget();
  }

  function handleResults(results) {
    if (!stream) return;
    const landmarks = results?.multiFaceLandmarks?.[0];
    const features = extractGazeFeatures(landmarks);

    if (!features) {
      showWarning('Face or eyes not detected — center your face and keep both eyes visible.');
      if (state === 'tracking') {
        marker.hidden = true;
        smoothedPoint = null;
      }
      return;
    }

    clearWarning();
    if (state === 'calibrating') {
      targetFeatureSamples.push(features);
      const elapsed = now() - targetStartedAt;
      if (elapsed >= TARGET_DWELL_MS && targetFeatureSamples.length >= MIN_TARGET_SAMPLES) {
        finishCalibrationTarget(averageFeatureVectors(targetFeatureSamples));
      }
      return;
    }

    if (state === 'tracking' && calibrationModel) {
      const point = calibrationModel.predict(features);
      if (point) positionMarker(point);
    }
  }

  async function refreshCameraList(selectedDeviceId = '') {
    if (typeof mediaDevices?.enumerateDevices !== 'function') return;
    try {
      const devices = await mediaDevices.enumerateDevices();
      const cameras = devices.filter((device) => device.kind === 'videoinput');
      const defaultOption = document.createElement('option');
      defaultOption.value = '';
      defaultOption.textContent = 'Default camera';
      cameraSelect.replaceChildren(defaultOption);
      cameras.forEach((camera, index) => {
        const option = document.createElement('option');
        option.value = camera.deviceId;
        option.textContent = camera.label || `Camera ${index + 1}`;
        cameraSelect.append(option);
      });
      if (selectedDeviceId && cameras.some((camera) => camera.deviceId === selectedDeviceId)) {
        cameraSelect.value = selectedDeviceId;
      }
    } catch {
      // Camera labels are optional; the browser default remains available.
    }
  }

  function scheduleFrame() {
    if (stream && typeof requestFrame === 'function') {
      animationFrameId = requestFrame(processFrame);
    }
  }

  async function processFrame() {
    if (!stream || !faceMesh) return;
    try {
      if (!frameInFlight && video.videoWidth > 0 && video.videoHeight > 0) {
        frameInFlight = true;
        await faceMesh.send({ image: video });
      }
    } catch (error) {
      setStatus(`Face tracking stopped${error?.message ? `: ${error.message}` : '.'}`, 'error');
      await stop({ preserveError: true });
      setState('error');
      return;
    } finally {
      frameInFlight = false;
    }
    scheduleFrame();
  }

  async function releaseCamera() {
    if (animationFrameId !== null && typeof cancelFrame === 'function') {
      cancelFrame(animationFrameId);
    }
    animationFrameId = null;
    const oldStream = stream;
    stream = null;
    if (oldStream) {
      for (const track of oldStream.getTracks()) track.stop();
    }
    video.srcObject = null;
    if (faceMesh && typeof faceMesh.close === 'function') {
      try {
        await faceMesh.close();
      } catch {
        // The camera still needs to be released if the model was already closing.
      }
    }
    faceMesh = null;
    frameInFlight = false;
  }

  async function startCamera() {
    if (stream || state === 'starting') return;
    if (typeof getUserMedia !== 'function') {
      setState('error');
      setStatus('This page cannot access a camera. Open it from localhost in current Chrome and allow camera access.', 'error');
      return;
    }
    if (typeof requestFrame !== 'function') {
      setState('error');
      setStatus('This browser does not provide the animation APIs required for live tracking.', 'error');
      return;
    }

    setState('starting');
    setStatus('Requesting camera access…');
    clearWarning();
    try {
      const selectedDeviceId = cameraSelect.value;
      const videoConstraints = {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: { ideal: 'user' },
      };
      if (selectedDeviceId) videoConstraints.deviceId = { exact: selectedDeviceId };
      stream = await getUserMedia({ video: videoConstraints, audio: false });
      video.srcObject = stream;
      video.hidden = false;
      if (typeof video.play === 'function') await video.play();

      faceMesh = createFaceMesh();
      faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.6,
      });
      faceMesh.onResults(handleResults);
      await refreshCameraList(selectedDeviceId);
      setState('ready');
      setStatus('Camera ready. Center your face, then start the nine-point calibration.');
      scheduleFrame();
    } catch (error) {
      await releaseCamera();
      video.hidden = true;
      setState('error');
      const message = error?.message?.includes('face-tracking model') ? error.message : cameraErrorMessage(error);
      setStatus(message, 'error');
    }
  }

  async function beginCalibration() {
    if (!stream || state === 'calibrating') return;
    calibrationIndex = 0;
    targetFeatureSamples = [];
    calibrationSamples = [];
    calibrationModel = null;
    smoothedPoint = null;
    marker.hidden = true;
    video.hidden = false;
    progress.hidden = false;
    progress.value = 0;
    setState('calibrating');
    targetStartedAt = now();
    renderCalibrationTarget();
    setStatus('Look at each glowing target and hold your gaze until it moves.');
    clearWarning();
  }

  async function stop({ preserveError = false } = {}) {
    await releaseCamera();
    resetCalibrationDisplay();
    video.hidden = true;
    calibrationIndex = 0;
    targetFeatureSamples = [];
    calibrationSamples = [];
    calibrationModel = null;
    clearWarning();
    if (!preserveError) {
      setState('idle');
      setStatus('Camera is off. Start the camera to begin.');
    }
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === trackerCard) {
        await document.exitFullscreen();
      } else if (typeof trackerCard.requestFullscreen === 'function') {
        await trackerCard.requestFullscreen();
      } else {
        setStatus('Fullscreen is not available in this browser.');
      }
    } catch {
      setStatus('Fullscreen could not be started. Try the fullscreen control again.');
    }
  }

  function updateFullscreenControls() {
    const isFullscreen = document.fullscreenElement === trackerCard;
    if (fullscreenButton) {
      fullscreenButton.setAttribute('aria-pressed', String(isFullscreen));
      fullscreenButton.innerHTML = isFullscreen ? '<span aria-hidden="true">⛶</span> Exit fullscreen' : '<span aria-hidden="true">⛶</span> Fullscreen';
    }
    if (fullscreenExitButton) fullscreenExitButton.hidden = !isFullscreen;
  }

  function onPageHide() {
    void stop();
  }

  function attach() {
    if (attached) return;
    attached = true;
    startButton.addEventListener('click', () => { void startCamera(); });
    calibrateButton.addEventListener('click', () => { void beginCalibration(); });
    recalibrateButton.addEventListener('click', () => { void beginCalibration(); });
    stopButton.addEventListener('click', () => { void stop(); });
    fullscreenButton?.addEventListener('click', () => { void toggleFullscreen(); });
    fullscreenExitButton?.addEventListener('click', () => { void toggleFullscreen(); });
    document.addEventListener('fullscreenchange', updateFullscreenControls);
    window?.addEventListener?.('pagehide', onPageHide);
    void refreshCameraList();
  }

  return {
    attach,
    startCamera,
    beginCalibration,
    stop,
    toggleFullscreen,
    get state() { return state; },
  };
}
