/**
 * LENS ENGINE — vector art anchored to ML Kit landmarks.
 *
 * The previous version drew filled circles near the ears. That is a debug
 * overlay, not a lens. Snapchat lenses read as lenses because they are
 * *drawn* — shaped fur with an inner ear, a muzzle with a nose and whiskers,
 * a frame with lenses that catch light.
 *
 * So the shapes here are Skia Paths built once at module scope, then placed
 * per frame with translate/scale from the face landmarks. Paths are host
 * objects and survive capture into the render worklet, which is why this works
 * without building geometry every frame on the GPU thread.
 *
 * Authoring space is 100 units, centred on (0,0), +y downward. Each lens is a
 * function that takes the already-resolved anchors and draws in that space, so
 * the maths that attaches the art to a face lives in exactly one place.
 *
 * Coordinates arrive in FRAME pixels and are normalised to 0..1 before crossing
 * the worklet boundary, so the same numbers work at any preview resolution.
 */

export type ArEffect = 'none' | 'dog' | 'shades' | 'bunny';

/** Flat order: ears(2) eyes(4) nose(2) box(4) yaw(1). */
export const FACE_STRIDE = 15;

interface RawFace {
  landmarks?: Record<string, { x: number; y: number } | undefined>;
  bounds: { x: number; y: number; width: number; height: number };
  yawAngle: number;
  frameWidth: number;
  frameHeight: number;
}

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

// ---------------------------------------------------------------------------
// Art. Built once. Never per frame.
// ---------------------------------------------------------------------------

type PathFactory = () => any;

/** Builds the lens art, given a Path constructor from Skia on the JS thread. */
export function buildLensArt(Skia: any) {
  const earOuter = Skia.Path.Make();
  // A leaf: pointed tip, wide rounded base.
  earOuter.moveTo(0, -100);
  earOuter.quadTo(58, -30, 44, 46);
  earOuter.quadTo(0, 78, -44, 46);
  earOuter.quadTo(-58, -30, 0, -100);
  earOuter.close();

  const earInner = Skia.Path.Make();
  earInner.moveTo(0, -58);
  earInner.quadTo(30, -14, 22, 26);
  earInner.quadTo(0, 42, -22, 26);
  earInner.quadTo(-30, -14, 0, -58);
  earInner.close();

  const muzzle = Skia.Path.Make();
  muzzle.addCircle(0, 0, 62);

  const nose = Skia.Path.Make();
  nose.moveTo(-22, -10);
  nose.quadTo(0, -24, 22, -10);
  nose.quadTo(0, 22, -22, -10);
  nose.close();

  const lensGlass = Skia.Path.Make();
  lensGlass.addCircle(0, 0, 46);

  const frame = Skia.Path.Make();
  frame.addCircle(0, 0, 52);

  const whisker = Skia.Path.Make();
  whisker.moveTo(0, 0);
  whisker.lineTo(78, -14);

  return { earOuter, earInner, muzzle, nose, lensGlass, frame, whisker } as Record<string, any>;
}

export type LensArt = ReturnType<typeof buildLensArt>;

type AnyCanvas = {
  save: () => void;
  restore: () => void;
  translate: (x: number, y: number) => void;
  scale: (sx: number, sy: number) => void;
  rotate: (deg: number) => void;
  drawPath: (p: any, paint: any) => void;
  drawCircle: (x: number, y: number, r: number, paint: any) => void;
};

/**
 * Draws one face's lens. Runs inside the Skia render worklet.
 * Paints arrive pre-coloured; nothing here converts a colour.
 */
export function drawFaceLens(
  canvas: AnyCanvas,
  art: LensArt,
  face: number[],
  width: number,
  height: number,
  effect: ArEffect,
  fur: any,
  furDark: any,
  pink: any,
  dark: any,
  glass: any,
  white: any,
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
  // Yaw nudges the art against the turn so the far side does not collapse onto
  // the near side before the head is fully sideways.
  const shift = (yaw / 45) * eyeGap * 0.12;

  if (effect === 'dog' || effect === 'bunny') {
    // Art is authored in a 100-unit box, so one scale factor sizes everything.
    const s = (faceSize * (effect === 'bunny' ? 0.30 : 0.26)) / 100;
    const lift = faceSize * 0.30;

    // ---- left ear
    canvas.save();
    canvas.translate(earLx + shift, earLy - lift);
    canvas.scale(s, s);
    canvas.drawPath(art.earOuter, effect === 'bunny' ? white : fur);
    canvas.drawPath(art.earInner, pink);
    canvas.restore();

    // ---- right ear, mirrored
    canvas.save();
    canvas.translate(earRx + shift, earRy - lift);
    canvas.scale(-s, s);
    canvas.drawPath(art.earOuter, effect === 'bunny' ? white : fur);
    canvas.drawPath(art.earInner, pink);
    canvas.restore();

    // ---- muzzle, sitting on the mouth line
    const ms = (faceSize * 0.34) / 100;
    canvas.save();
    canvas.translate(noseX + shift, noseY + faceSize * 0.06);
    canvas.scale(ms, ms);
    canvas.drawPath(art.muzzle, effect === 'bunny' ? white : furDark);
    canvas.restore();

    // ---- nose + whiskers
    canvas.save();
    canvas.translate(noseX + shift, noseY);
    canvas.scale(ms, ms);
    canvas.drawPath(art.nose, dark);
    canvas.restore();

    const ws = (faceSize * 0.42) / 100;
    for (let i = 0; i < 2; i++) {
      const flip = i === 0 ? 1 : -1;
      canvas.save();
      canvas.translate(noseX + shift, noseY + faceSize * 0.05);
      canvas.scale(ws * flip, ws);
      canvas.rotate(-6);
      canvas.drawPath(art.whisker, white);
      canvas.restore();

      canvas.save();
      canvas.translate(noseX + shift, noseY + faceSize * 0.05);
      canvas.scale(ws * flip, ws);
      canvas.rotate(8);
      canvas.drawPath(art.whisker, white);
      canvas.restore();
    }
    return;
  }

  if (effect === 'shades') {
    const r = eyeGap * 0.62;
    const lensS = r / 52;

    // Frame band across the bridge, then each lens.
    canvas.save();
    canvas.translate((eyeLx + eyeRx) / 2 + shift, (eyeLy + eyeRy) / 2);
    canvas.scale(lensS, lensS);
    canvas.drawPath(art.frame, dark);
    canvas.restore();

    for (let i = 0; i < 2; i++) {
      const ex = (i === 0 ? eyeLx : eyeRx) + shift;
      const ey = i === 0 ? eyeLy : eyeRy;
      canvas.save();
      canvas.translate(ex, ey);
      canvas.scale(lensS, lensS);
      canvas.drawPath(art.lensGlass, glass);
      // specular catch, the thing that makes a lens read as glass
      canvas.drawCircle(-16, -18, 10, white);
      canvas.restore();
    }
  }
}
