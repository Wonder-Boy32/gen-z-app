/**
 * AR OVERLAYS — drawn from ML Kit landmarks, not from fixed screen positions.
 *
 * The face detector hands us, per face: the landmark points, the bounding box,
 * and pitch/roll/yaw. That is enough to attach things to the face and have them
 * stay attached when the head turns, tilts, or moves closer.
 *
 * Coordinates arrive in FRAME pixels. Everything is converted to a fraction of
 * the frame first, so the same numbers work at whatever resolution the session
 * negotiates — a 720p preview and a 1080p one draw the same overlay.
 *
 * Yaw shifts the overlay slightly against the direction of the turn. The
 * landmarks already move, but the far-side ear foreshortens to nothing before
 * the head is fully sideways; a small counter-shift keeps the pair reading as
 * attached instead of collapsing into one blob.
 *
 * Colours are NOT set in here. The worklet receives Paint objects whose colour
 * was already assigned on the JS thread, because hex-to-Skia-colour conversion
 * is not something to rely on inside the worklet runtime.
 */

export type ArEffect = 'none' | 'ears' | 'glasses' | 'nose';

/** Flat order: ears(2) eyes(4) nose(2) box(4) yaw(1). */
export const FACE_STRIDE = 15;

interface RawFace {
  landmarks?: Record<string, { x: number; y: number } | undefined>;
  bounds: { x: number; y: number; width: number; height: number };
  yawAngle: number;
  frameWidth: number;
  frameHeight: number;
}

/** Normalises one detected face into a flat number array a worklet can hold. */
export function packFace(f: RawFace): number[] | null {
  const lm = f.landmarks;
  if (!lm?.LEFT_EAR || !lm.RIGHT_EAR || !lm.LEFT_EYE || !lm.RIGHT_EYE || !lm.NOSE_BASE) {
    return null;
  }
  const fw = f.frameWidth || 1;
  const fh = f.frameHeight || 1;
  return [
    lm.LEFT_EAR.x / fw,
    lm.LEFT_EAR.y / fh,
    lm.RIGHT_EAR.x / fw,
    lm.RIGHT_EAR.y / fh,
    lm.LEFT_EYE.x / fw,
    lm.LEFT_EYE.y / fh,
    lm.RIGHT_EYE.x / fw,
    lm.RIGHT_EYE.y / fh,
    lm.NOSE_BASE.x / fw,
    lm.NOSE_BASE.y / fh,
    f.bounds.x / fw,
    f.bounds.y / fh,
    f.bounds.width / fw,
    f.bounds.height / fh,
    f.yawAngle ?? 0,
  ];
}

type AnyCanvas = { drawCircle: (x: number, y: number, r: number, p: any) => void };

/**
 * Draws one face's overlay inside the Skia render worklet.
 * `paintMain` / `paintAccent` arrive pre-coloured.
 */
export function drawFaceOverlays(
  canvas: AnyCanvas,
  face: number[],
  width: number,
  height: number,
  effect: ArEffect,
  paintMain: any,
  paintAccent: any,
): void {
  'worklet';
  const earLx = face[0] * width;
  const earLy = face[1] * height;
  const earRx = face[2] * width;
  const earRy = face[3] * height;
  const eyeLx = face[4] * width;
  const eyeLy = face[5] * height;
  const eyeRx = face[6] * width;
  const eyeRy = face[7] * height;
  const noseX = face[8] * width;
  const noseY = face[9] * height;
  const boxH = face[13] * height;
  const yaw = face[14];

  const eyeGap = Math.max(1, Math.abs(eyeRx - eyeLx));
  const faceSize = Math.max(boxH, eyeGap);
  const shift = (yaw / 45) * eyeGap * 0.12;

  if (effect === 'ears') {
    const r = faceSize * 0.22;
    const lift = faceSize * 0.34;
    canvas.drawCircle(earLx + shift, earLy - lift, r, paintMain);
    canvas.drawCircle(earRx + shift, earRy - lift, r, paintMain);
    canvas.drawCircle(earLx + shift, earLy - lift, r * 0.5, paintAccent);
    canvas.drawCircle(earRx + shift, earRy - lift, r * 0.5, paintAccent);
    return;
  }

  if (effect === 'glasses') {
    const r = eyeGap * 0.3;
    canvas.drawCircle(eyeLx + shift, eyeLy, r, paintMain);
    canvas.drawCircle(eyeRx + shift, eyeRy, r, paintMain);
    canvas.drawCircle(eyeLx + shift, eyeLy, r * 0.55, paintAccent);
    canvas.drawCircle(eyeRx + shift, eyeRy, r * 0.55, paintAccent);
    return;
  }

  if (effect === 'nose') {
    const r = faceSize * 0.13;
    canvas.drawCircle(noseX + shift, noseY, r, paintMain);
    canvas.drawCircle(noseX + shift - r * 0.3, noseY - r * 0.3, r * 0.28, paintAccent);
  }
}
