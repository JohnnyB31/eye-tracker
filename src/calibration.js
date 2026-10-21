const IRIS_GROUPS = [
  { iris: [468, 469, 470, 471, 472], corners: [33, 133], upper: 159, lower: 145 },
  { iris: [473, 474, 475, 476, 477], corners: [362, 263], upper: 386, lower: 374 },
];

function mean(points, axis) {
  return points.reduce((total, point) => total + point[axis], 0) / points.length;
}

function pointAt(landmarks, index) {
  const point = landmarks[index];
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
}

function averagePoints(landmarks, indexes) {
  const points = indexes.map((index) => pointAt(landmarks, index));
  if (points.some((point) => point === null)) return null;
  return { x: mean(points, 'x'), y: mean(points, 'y') };
}

/**
 * Extract a compact gaze/head-position vector from refined MediaPipe Face Mesh
 * landmarks. Iris position is measured relative to the eye contour so the
 * values are not tied to the face's pixel size in the camera frame.
 */
export function extractGazeFeatures(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 478) return null;

  const eyes = [];
  for (const group of IRIS_GROUPS) {
    const iris = averagePoints(landmarks, group.iris);
    const corners = group.corners.map((index) => pointAt(landmarks, index));
    const upper = pointAt(landmarks, group.upper);
    const lower = pointAt(landmarks, group.lower);
    if (!iris || corners.some((point) => point === null) || !upper || !lower) return null;

    const left = Math.min(corners[0].x, corners[1].x);
    const right = Math.max(corners[0].x, corners[1].x);
    const top = Math.min(upper.y, lower.y);
    const bottom = Math.max(upper.y, lower.y);
    const width = right - left;
    const height = bottom - top;
    if (width < 0.001 || height < 0.001) return null;

    eyes.push({
      gazeX: (iris.x - left) / width,
      gazeY: (iris.y - top) / height,
      centerX: (left + right) / 2,
      centerY: (top + bottom) / 2,
    });
  }

  const features = [
    (eyes[0].gazeX + eyes[1].gazeX) / 2,
    (eyes[0].gazeY + eyes[1].gazeY) / 2,
    (eyes[0].centerX + eyes[1].centerX) / 2,
    (eyes[0].centerY + eyes[1].centerY) / 2,
  ];
  return features.every(Number.isFinite) ? features : null;
}

export function averageFeatureVectors(vectors) {
  if (!vectors.length) return null;
  const size = vectors[0].length;
  if (vectors.some((vector) => vector.length !== size || vector.some((value) => !Number.isFinite(value)))) {
    return null;
  }

  return Array.from({ length: size }, (_, index) => (
    vectors.reduce((total, vector) => total + vector[index], 0) / vectors.length
  ));
}

function solveLinearSystem(matrix, values) {
  const size = values.length;
  const augmented = matrix.map((row, index) => [...row, values[index]]);

  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivotRow][column])) pivotRow = row;
    }

    if (Math.abs(augmented[pivotRow][column]) < 1e-12) return null;
    [augmented[column], augmented[pivotRow]] = [augmented[pivotRow], augmented[column]];

    const pivot = augmented[column][column];
    for (let index = column; index <= size; index += 1) augmented[column][index] /= pivot;

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index <= size; index += 1) {
        augmented[row][index] -= factor * augmented[column][index];
      }
    }
  }

  return augmented.map((row) => row[size]);
}

function fitAxis(rows, values, regularization) {
  const dimensions = rows[0].length;
  const gram = Array.from({ length: dimensions }, () => Array(dimensions).fill(0));
  const projected = Array(dimensions).fill(0);

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    for (let left = 0; left < dimensions; left += 1) {
      projected[left] += row[left] * values[rowIndex];
      for (let right = 0; right < dimensions; right += 1) {
        gram[left][right] += row[left] * row[right];
      }
    }
  }

  // Keep the intercept unregularized so the mapping can follow the user's
  // calibration centre while gently damping correlated eye/head features.
  for (let index = 1; index < dimensions; index += 1) gram[index][index] += regularization;
  return solveLinearSystem(gram, projected);
}

/** Fit a small regularized linear gaze-to-app-coordinate mapping. */
export function fitCalibration(samples, regularization = 0.01) {
  if (!Array.isArray(samples) || samples.length < 5) return null;
  const featureCount = samples[0]?.features?.length;
  if (!Number.isInteger(featureCount) || featureCount === 0) return null;
  if (samples.some((sample) => (
    sample.features?.length !== featureCount
    || sample.features.some((value) => !Number.isFinite(value))
    || !Number.isFinite(sample.target?.x)
    || !Number.isFinite(sample.target?.y)
  ))) return null;

  const means = Array.from({ length: featureCount }, (_, index) => (
    samples.reduce((total, sample) => total + sample.features[index], 0) / samples.length
  ));
  const scales = Array.from({ length: featureCount }, (_, index) => {
    const variance = samples.reduce((total, sample) => (
      total + (sample.features[index] - means[index]) ** 2
    ), 0) / samples.length;
    const scale = Math.sqrt(variance);
    return scale > 1e-6 ? scale : 1;
  });
  const rows = samples.map((sample) => [
    1,
    ...sample.features.map((value, index) => (value - means[index]) / scales[index]),
  ]);
  const xWeights = fitAxis(rows, samples.map((sample) => sample.target.x), regularization);
  const yWeights = fitAxis(rows, samples.map((sample) => sample.target.y), regularization);
  if (!xWeights || !yWeights) return null;

  return {
    predict(features) {
      if (!Array.isArray(features) || features.length !== featureCount || !features.every(Number.isFinite)) {
        return null;
      }
      const row = [1, ...features.map((value, index) => (value - means[index]) / scales[index])];
      const dot = (weights) => weights.reduce((total, weight, index) => total + weight * row[index], 0);
      const point = { x: dot(xWeights), y: dot(yWeights) };
      return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
    },
  };
}

export function smoothPoint(previous, next, alpha = 0.3) {
  if (!next || !Number.isFinite(next.x) || !Number.isFinite(next.y)) return null;
  if (!previous || !Number.isFinite(previous.x) || !Number.isFinite(previous.y)) {
    return { x: next.x, y: next.y };
  }
  const factor = Math.min(1, Math.max(0, alpha));
  return {
    x: previous.x + (next.x - previous.x) * factor,
    y: previous.y + (next.y - previous.y) * factor,
  };
}
