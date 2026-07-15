export type {
  BoundingBox,
  Point,
} from './click-enhanced.js';
export type {
  HumanScrollOptions,
  ScrollIntoViewOptions,
} from './scroll-enhanced.js';
export type {
  InterceptControl,
  InterceptHandler,
  Primitives,
  RateLimitConfig,
  ScrollOptions,
  Snapshot,
  SnapshotNode,
  ThrottleConfig,
} from './types.js';
export type {
  ClickEnhancementConfig,
  PrimitivesErrorContext,
  RuntimePrimitivesErrorCtor,
  RuntimePrimitivesHooks,
} from './hooks.js';
export type { AuthGuardCheckResult, AuthGuardConfig } from './auth-guard.js';
export type { DetectFn, RateLimitSignal } from './rate-limit-detect.js';
export type { PuppeteerBackendOptions } from './puppeteer-backend.js';
export type {
  CreateSecurePuppeteerPrimitivesOptions,
  SecurePrimitives,
} from './secure-factory.js';
export type {
  TextRun,
  PinyinChar,
  ImeTiming,
  KeyboardLike,
  AsciiTypingOptions,
} from './keyboard-enhanced.js';

export { createAuthGuardedPrimitives } from './auth-guard.js';
export {
  applyJitter,
  checkOcclusion,
  clickWithTrajectory,
  easeInOutCubic,
  generateBezierPath,
  injectCoordFix,
  isPositionStable,
  waitForElementStable,
} from './click-enhanced.js';
export { generateHumanizedPath, movePointerAlong } from './trajectory.js';
export type { HumanizedPathOptions } from './trajectory.js';
export { createSecurePuppeteerPrimitives } from './secure-factory.js';
export { createRuntimePrimitivesError, getResolvedClickEnhancementConfig } from './hooks.js';
export {
  defaultDetect,
  RateLimitDetector,
} from './rate-limit-detect.js';
export { SlidingWindowRateLimiter } from './rate-limiter.js';
export { PuppeteerBackend } from './puppeteer-backend.js';
export { humanScroll, scrollElementIntoView } from './scroll-enhanced.js';
export { createThrottledPrimitives } from './throttle.js';
export {
  isCjkCodePoint,
  containsCjk,
  splitCjkRuns,
  segmentCjkWords,
  wordToPinyin,
  imeComposeText,
  typeAsciiHumanized,
  DEFAULT_KEY_DWELL_MS,
} from './keyboard-enhanced.js';
