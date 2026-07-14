import type { Page, CDPSession } from 'puppeteer-core';
import type { BoundingBox, Point } from './click-enhanced.js';
import type { HumanScrollOptions, ScrollIntoViewOptions } from './scroll-enhanced.js';
import type { ImeTiming } from './keyboard-enhanced.js';

export interface PrimitivesErrorContext {
  url?: string;
  step?: string;
  snapshotSummary?: string;
  screenshotBase64?: string;
  retryable?: boolean;
  hint?: string;
  diagnostics?: unknown;
}

export type RuntimePrimitivesErrorCtor = new (
  message: string,
  context?: PrimitivesErrorContext,
) => Error;

export interface ClickEnhancementConfig {
  trajectory: boolean;
  jitter: boolean;
  occlusionCheck: boolean;
}

export interface RuntimePrimitivesHooks {
  ElementNotFound?: RuntimePrimitivesErrorCtor;
  NavigationFailed?: RuntimePrimitivesErrorCtor;
  SessionExpired?: RuntimePrimitivesErrorCtor;
  RateLimited?: RuntimePrimitivesErrorCtor;
  CdpThrottled?: RuntimePrimitivesErrorCtor;
  getClickEnhancementConfig?: () => ClickEnhancementConfig;
  applyJitter?: (
    x: number,
    y: number,
    maxOffset?: number,
    box?: BoundingBox,
    paddingPct?: number,
  ) => Point;
  checkOcclusion?: (
    page: Page,
    x: number,
    y: number,
    expectedBackendNodeId: number,
  ) => Promise<{ occluded: boolean; fallback?: Point }>;
  waitForElementStable?: (
    page: Page,
    backendNodeId: number,
    options?: { timeoutMs?: number; pollIntervalMs?: number; threshold?: number },
  ) => Promise<{ center: Point; box: BoundingBox }>;
  clickWithTrajectory?: (
    page: Page,
    targetX: number,
    targetY: number,
    options?: { stepDelayMs?: number; overshoot?: boolean; box?: BoundingBox },
  ) => Promise<'ok' | 'throttled'>;
  injectCoordFix?: (page: Page) => Promise<void>;
  humanScroll?: (
    page: Page,
    deltaX: number,
    deltaY: number,
    options?: HumanScrollOptions,
  ) => Promise<'ok' | 'throttled'>;
  scrollElementIntoView?: (
    page: Page,
    backendNodeId: number,
    options?: ScrollIntoViewOptions,
  ) => Promise<void>;
  imeCompose?: (
    client: CDPSession,
    text: string,
    timing?: ImeTiming,
  ) => Promise<void>;
}

export const DEFAULT_CLICK_ENHANCEMENT_CONFIG: ClickEnhancementConfig = {
  trajectory: true,
  jitter: true,
  occlusionCheck: true,
};

export function createRuntimePrimitivesError(
  name: string,
  ctor: RuntimePrimitivesErrorCtor | undefined,
  message: string,
  context: PrimitivesErrorContext = {},
): Error {
  if (ctor) {
    return new ctor(message, context);
  }

  const error = new Error(message) as Error & {
    type?: string;
    context?: PrimitivesErrorContext;
  };
  error.name = name;
  error.type = name;
  error.context = context;
  return error;
}

export function getResolvedClickEnhancementConfig(
  hooks: RuntimePrimitivesHooks,
): ClickEnhancementConfig {
  return hooks.getClickEnhancementConfig?.() ?? DEFAULT_CLICK_ENHANCEMENT_CONFIG;
}
