export type {
  SitePlugin,
  FeedItem,
  FeedMeta,
  FeedResult,
  MediaItem,
  CheckLoginResult,
  AuthCapability,
  FeedCapability,
  WorkflowDeclaration,
  StoreAdapter,
  SiteErrorHints,
  ExposeTarget,
  CliConfig,
} from './types.js';

export { validatePlugins } from './validation.js';
export { discoverPlugins, mergePlugins } from './discovery.js';
export { generateMcpTools, generateCliCommands } from './codegen.js';
export type { GeneratedMcpTool, GeneratedCliCommand } from './codegen.js';
export { wrapToolHandler } from './tool-wrapper.js';
export { resolveHint } from './default-descriptions.js';
