import type { AvatarIntent, AvatarGesture } from "./index";

export interface AvatarVector3 {
  x: number;
  y: number;
  z: number;
}

export interface AvatarHandGoal {
  /** Outward from the body, in units of total arm length. */
  lateral: number;
  /** Upward from the shoulder, in units of total arm length. */
  vertical: number;
  /** Toward the character's front, in units of total arm length. */
  forward: number;
}

export interface AvatarBoneFrame {
  leftHand: AvatarHandGoal;
  rightHand: AvatarHandGoal;
  torsoLean: number;
  weightShift: number;
}

const REST_FRAME: AvatarBoneFrame = {
  leftHand: { lateral: 0.48, vertical: -0.56, forward: 0.06 },
  rightHand: { lateral: 0.48, vertical: -0.56, forward: 0.06 },
  torsoLean: 0,
  weightShift: 0
};

function frameForGesture(gesture: AvatarGesture): AvatarBoneFrame {
  switch (gesture) {
    case "explain":
      return {
        leftHand: { lateral: 0.42, vertical: -0.18, forward: 0.66 },
        rightHand: { lateral: 0.42, vertical: -0.06, forward: 0.86 },
        torsoLean: 0.015, weightShift: 0.025
      };
    case "greet":
      return {
        leftHand: REST_FRAME.leftHand,
        rightHand: { lateral: 0.18, vertical: 0.78, forward: 0.34 },
        torsoLean: 0.025, weightShift: 0
      };
    case "think":
      return {
        leftHand: REST_FRAME.leftHand,
        rightHand: { lateral: 0.19, vertical: 0.24, forward: 0.78 },
        torsoLean: 0.035, weightShift: -0.015
      };
    case "reassure":
      return {
        leftHand: { lateral: 0.32, vertical: -0.22, forward: 0.74 },
        rightHand: { lateral: 0.32, vertical: -0.22, forward: 0.74 },
        torsoLean: 0.02, weightShift: 0
      };
    case "celebrate":
      return {
        leftHand: { lateral: 0.28, vertical: 0.72, forward: 0.25 },
        rightHand: { lateral: 0.28, vertical: 0.72, forward: 0.25 },
        torsoLean: -0.015, weightShift: 0
      };
    case "apologize":
      return {
        leftHand: { lateral: 0.22, vertical: -0.32, forward: 0.68 },
        rightHand: { lateral: 0.22, vertical: -0.32, forward: 0.68 },
        torsoLean: 0.055, weightShift: -0.025
      };
    case "rest":
    default:
      return { ...REST_FRAME, leftHand: { ...REST_FRAME.leftHand }, rightHand: { ...REST_FRAME.rightHand } };
  }
}

function inferredGesture(intent: AvatarIntent): AvatarGesture {
  if (intent.gesture) return intent.gesture;
  if (intent.action === "wave") return "greet";
  if (intent.action === "look") return "think";
  if (intent.action === "talk") return "explain";
  return "rest";
}

function lerp(a: number, b: number, amount: number): number {
  return a + (b - a) * amount;
}

function blendHand(current: AvatarHandGoal, target: AvatarHandGoal, amount: number): AvatarHandGoal {
  return {
    lateral: lerp(current.lateral, target.lateral, amount),
    vertical: lerp(current.vertical, target.vertical, amount),
    forward: lerp(current.forward, target.forward, amount)
  };
}

/**
 * Converts semantic gestures into continuously blended hand-space targets.
 * It does not select or play animation clips; the renderer solves each arm as a two-bone chain.
 */
export class AvatarBoneController {
  private current: AvatarBoneFrame = {
    ...REST_FRAME,
    leftHand: { ...REST_FRAME.leftHand },
    rightHand: { ...REST_FRAME.rightHand }
  };
  private activeGoal: AvatarBoneFrame = this.current;
  private gesture: AvatarGesture = "rest";
  private action: AvatarIntent["action"] = "idle";
  private elapsed = 0;
  private durationMs = 0;

  setIntent(intent: AvatarIntent): void {
    this.gesture = inferredGesture(intent);
    this.action = intent.action;
    this.activeGoal = frameForGesture(this.gesture);
    this.elapsed = 0;
    this.durationMs = Math.max(500, Math.min(5000, intent.durationMs ?? 2200));
  }

  hasFinishedGesture(): boolean {
    return this.action !== "talk" && this.elapsed * 1000 >= this.durationMs;
  }

  update(deltaSeconds: number): AvatarBoneFrame {
    const delta = Math.max(0, Math.min(0.1, Number.isFinite(deltaSeconds) ? deltaSeconds : 0));
    this.elapsed += delta;
    const isActive = this.action === "talk" || this.elapsed * 1000 < this.durationMs;
    const target = isActive ? this.activeGoal : REST_FRAME;
    const smoothing = 1 - Math.exp(-delta * 7.5);
    this.current = {
      leftHand: blendHand(this.current.leftHand, target.leftHand, smoothing),
      rightHand: blendHand(this.current.rightHand, target.rightHand, smoothing),
      torsoLean: lerp(this.current.torsoLean, target.torsoLean, smoothing),
      weightShift: lerp(this.current.weightShift, target.weightShift, smoothing)
    };

    // Speech gestures are small changes in endpoint goals, not loops over authored clips.
    if (isActive && this.action === "talk") {
      const emphasis = Math.sin(this.elapsed * 2.4) * 0.035;
      this.current.leftHand.vertical += emphasis * 0.45;
      this.current.rightHand.vertical += emphasis;
      this.current.torsoLean += Math.sin(this.elapsed * 1.3) * 0.008;
    }
    // A greeting is a short wrist/hand target oscillation produced by the IK solver.
    if (isActive && this.gesture === "greet") {
      this.current.rightHand.lateral += Math.sin(this.elapsed * 8) * 0.055;
    }
    return {
      leftHand: { ...this.current.leftHand },
      rightHand: { ...this.current.rightHand },
      torsoLean: this.current.torsoLean,
      weightShift: this.current.weightShift
    };
  }
}

function add(a: AvatarVector3, b: AvatarVector3): AvatarVector3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function subtract(a: AvatarVector3, b: AvatarVector3): AvatarVector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function scale(v: AvatarVector3, amount: number): AvatarVector3 {
  return { x: v.x * amount, y: v.y * amount, z: v.z * amount };
}
function dot(a: AvatarVector3, b: AvatarVector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function length(v: AvatarVector3): number {
  return Math.sqrt(dot(v, v));
}
function normalize(v: AvatarVector3, fallback: AvatarVector3): AvatarVector3 {
  const magnitude = length(v);
  return magnitude > 1e-8 && Number.isFinite(magnitude) ? scale(v, 1 / magnitude) : fallback;
}

/**
 * Analytic two-bone IK (upper arm + forearm). Inputs and outputs share one coordinate space.
 * Unreachable targets are clamped to the chain's safe reachable interval.
 */
export function solveTwoBoneIk(
  origin: AvatarVector3,
  target: AvatarVector3,
  upperLength: number,
  lowerLength: number,
  bendHint: AvatarVector3
): { elbow: AvatarVector3; wrist: AvatarVector3; reach: number } {
  const upper = Math.max(1e-5, Number.isFinite(upperLength) ? upperLength : 1);
  const lower = Math.max(1e-5, Number.isFinite(lowerLength) ? lowerLength : 1);
  const rawDirection = subtract(target, origin);
  const rawDistance = length(rawDirection);
  const direction = normalize(rawDirection, { x: 0, y: 1, z: 0 });
  const minReach = Math.abs(upper - lower) + 1e-5;
  const maxReach = Math.max(minReach, upper + lower - 1e-5);
  const reach = Math.max(minReach, Math.min(maxReach, rawDistance || minReach));
  const wrist = add(origin, scale(direction, reach));
  const along = (upper * upper - lower * lower + reach * reach) / (2 * reach);
  const height = Math.sqrt(Math.max(0, upper * upper - along * along));
  let bend = subtract(bendHint, scale(direction, dot(bendHint, direction)));
  if (length(bend) < 1e-7) {
    const fallback = Math.abs(direction.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    bend = subtract(fallback, scale(direction, dot(fallback, direction)));
  }
  bend = normalize(bend, { x: 0, y: 0, z: 1 });
  const elbow = add(origin, add(scale(direction, along), scale(bend, height)));
  return { elbow, wrist, reach };
}
