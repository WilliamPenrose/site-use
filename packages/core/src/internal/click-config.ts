export interface ClickEnhancementConfig {
  trajectory: boolean;
  jitter: boolean;
  occlusionCheck: boolean;
}

export function getClickEnhancementConfig(): ClickEnhancementConfig {
  return {
    trajectory: true,
    jitter: true,
    occlusionCheck: true,
  };
}
