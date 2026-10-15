// lib/strata.js — public façade.
//
// 1.1.0 split the lifecycle logic into lib/deployer/ (local source + container,
// chosen by the active profile's `type`). routes/ and tools/ keep importing
// these exact names; the functions below just forward to the active deployer.
//
// Pure/shared helpers (config parsing, metrics regex, text edits, network
// exposure, profile persistence) live in lib/deployer/common.js and
// lib/profiles.js and are re-exported here so the public surface is stable.
export {
  DEFAULTS,
  FALLBACK_PORT,
  readConfig,
  readAllConfig,
  savePluginConfig,
  writeProfiles,
  patchActiveProfile,
  listConfigFiles,
  describeConfigFile,
  pickConfigFile,
  resolvePort,
  resolveApiKey,
  effectiveContainerFields,
  readConfigSummary,
  buildConfigView,
  buildNetwork,
  parseMetrics,
  generateApiKey,
  getLatestVersion,
} from "./deployer/common.js";

export {
  PROFILE_TYPES,
  DEFAULT_PROFILE_NAME,
  DEFAULT_MODELS_BIND_DIR,
  CONTAINER_LIST_FIELDS,
  emptyLocalProfile,
  emptyContainerProfile,
  makeDefaultProfile,
  normalizeProfile,
  parseProfiles,
  profileFromFlat,
  ensureProfiles,
  serializeProfiles,
  findProfile,
  validateProfile,
  profileReady,
  profileSummary,
} from "./profiles.js";

export { GPU_MODELS, GPU_MODEL_KEYS, GPU_VENDORS, gpuModelCatalog, gpuModelInfo, parseGpuIds, gpuTemplate } from "./gpu.js";

export {
  getStatus,
  startService,
  stopService,
  restartService,
  getConfigView,
  applyConfigEdits,
  readLogs,
  setHostMode,
  selectProfile,
  readRecentLogs,
} from "./deployer/index.js";
