// lib/strata.js — public façade.
//
// 1.1.0 moved the actual lifecycle logic into lib/deployer/ (source + docker,
// chosen by deploy-mode detection). routes/ and tools/ keep importing these
// exact names; the functions below just forward to the active deployer.
//
// Pure/shared helpers (config parsing, metrics regex, text edits, network
// exposure) live in lib/deployer/common.js and are re-exported here so the
// public surface is unchanged.
export {
  DEFAULTS,
  FALLBACK_PORT,
  readConfig,
  readAllConfig,
  savePluginConfig,
  listConfigFiles,
  describeConfigFile,
  pickConfigFile,
  resolvePort,
  resolveApiKey,
  readConfigSummary,
  buildConfigView,
  buildNetwork,
  parseMetrics,
  generateApiKey,
  getLatestVersion,
  normalizeImageNames,
  detectionImageNames,
} from "./deployer/common.js";

export {
  detect,
  getStatus,
  startService,
  stopService,
  restartService,
  getConfigView,
  applyConfigEdits,
  readLogs,
  updateService,
  switchDeployMode,
  setHostMode,
  readRecentLogs,
} from "./deployer/index.js";
