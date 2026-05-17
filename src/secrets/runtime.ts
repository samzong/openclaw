import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForSecretsRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { resolveUserPath } from "../utils.js";
import {
  measureSecretsDiagnosticsSpan,
  measureSecretsDiagnosticsSpanSync,
  type SecretsDiagnosticAttributes,
} from "./runtime-diagnostics.js";
import { type SecretResolverWarning } from "./runtime-shared.js";
import {
  clearActiveRuntimeWebToolsMetadata,
  getActiveRuntimeWebToolsMetadata as getActiveRuntimeWebToolsMetadataFromState,
  setActiveRuntimeWebToolsMetadata,
} from "./runtime-web-tools-state.js";
import type { RuntimeWebToolsMetadata } from "./runtime-web-tools.js";

export type { SecretResolverWarning } from "./runtime-shared.js";

export type PreparedSecretsRuntimeSnapshot = {
  sourceConfig: OpenClawConfig;
  config: OpenClawConfig;
  authStores: Array<{ agentDir: string; store: AuthProfileStore }>;
  warnings: SecretResolverWarning[];
  webTools: RuntimeWebToolsMetadata;
  diagnostics: SecretsRuntimeDiagnostics;
};

export type SecretsRuntimePrepareDiagnostics = {
  envMs: number;
  cloneMs: number;
  authStoreLoadMs: number;
  fastPathCheckMs: number;
  importRuntimePrepareMs: number;
  loadablePluginOriginsMs: number;
  collectConfigAssignmentsMs: number;
  collectAuthStoreAssignmentsMs: number;
  resolveSecretRefsMs: number;
  applyAssignmentsMs: number;
  resolveWebToolsMs: number;
  totalMs: number;
  candidateAgentDirCount: number;
  authStoreCount: number;
  assignmentCount: number;
  warningCount: number;
  hasWebTools: boolean;
  webSearchProviderSource: string;
  webFetchProviderSource: string;
  webSearchProviderCount: number;
  webFetchProviderCount: number;
  webDiagnosticCount: number;
};

export type SecretsRuntimeDiagnostics = {
  prepare: SecretsRuntimePrepareDiagnostics;
};

type SecretsRuntimeRefreshContext = {
  env: Record<string, string | undefined>;
  explicitAgentDirs: string[] | null;
  loadAuthStore: (agentDir?: string) => AuthProfileStore;
  loadablePluginOrigins: ReadonlyMap<string, PluginOrigin>;
};

const RUNTIME_PATH_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
  "OPENCLAW_TEST_FAST",
] as const;

let activeSnapshot: PreparedSecretsRuntimeSnapshot | null = null;
let activeRefreshContext: SecretsRuntimeRefreshContext | null = null;
const preparedSnapshotRefreshContext = new WeakMap<
  PreparedSecretsRuntimeSnapshot,
  SecretsRuntimeRefreshContext
>();
let runtimeManifestPromise: Promise<typeof import("./runtime-manifest.runtime.js")> | null = null;
let runtimePreparePromise: Promise<typeof import("./runtime-prepare.runtime.js")> | null = null;

function loadRuntimeManifestHelpers() {
  runtimeManifestPromise ??= import("./runtime-manifest.runtime.js");
  return runtimeManifestPromise;
}

function loadRuntimePrepareHelpers() {
  runtimePreparePromise ??= import("./runtime-prepare.runtime.js");
  return runtimePreparePromise;
}

function cloneSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: structuredClone(snapshot.sourceConfig),
    config: structuredClone(snapshot.config),
    authStores: snapshot.authStores.map((entry) => ({
      agentDir: entry.agentDir,
      store: structuredClone(entry.store),
    })),
    warnings: snapshot.warnings.map((warning) => ({ ...warning })),
    webTools: structuredClone(snapshot.webTools),
    diagnostics: structuredClone(snapshot.diagnostics),
  };
}

function cloneRefreshContext(context: SecretsRuntimeRefreshContext): SecretsRuntimeRefreshContext {
  return {
    env: { ...context.env },
    explicitAgentDirs: context.explicitAgentDirs ? [...context.explicitAgentDirs] : null,
    loadAuthStore: context.loadAuthStore,
    loadablePluginOrigins: new Map(context.loadablePluginOrigins),
  };
}

function clearActiveSecretsRuntimeState(): void {
  activeSnapshot = null;
  activeRefreshContext = null;
  clearActiveRuntimeWebToolsMetadata();
  setRuntimeConfigSnapshotRefreshHandler(null);
  clearRuntimeConfigSnapshot();
  clearRuntimeAuthProfileStoreSnapshots();
}

function collectCandidateAgentDirs(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const dirs = new Set<string>();
  dirs.add(resolveUserPath(resolveDefaultAgentDir(config, env), env));
  for (const agentId of listAgentIds(config)) {
    dirs.add(resolveUserPath(resolveAgentDir(config, agentId, env), env));
  }
  return [...dirs];
}

function resolveRefreshAgentDirs(
  config: OpenClawConfig,
  context: SecretsRuntimeRefreshContext,
): string[] {
  const configDerived = collectCandidateAgentDirs(config, context.env);
  if (!context.explicitAgentDirs || context.explicitAgentDirs.length === 0) {
    return configDerived;
  }
  return [...new Set([...context.explicitAgentDirs, ...configDerived])];
}

async function resolveLoadablePluginOrigins(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<ReadonlyMap<string, PluginOrigin>> {
  const workspaceDir = resolveAgentWorkspaceDir(
    params.config,
    resolveDefaultAgentId(params.config),
  );
  const { listPluginOriginsFromMetadataSnapshot, loadPluginMetadataSnapshot } =
    await loadRuntimeManifestHelpers();
  const snapshot = loadPluginMetadataSnapshot({
    config: params.config,
    workspaceDir,
    env: params.env,
  });
  return listPluginOriginsFromMetadataSnapshot(snapshot);
}

function mergeSecretsRuntimeEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  const merged = { ...(env ?? process.env) } as Record<string, string | undefined>;
  for (const key of RUNTIME_PATH_ENV_KEYS) {
    if (merged[key] !== undefined) {
      continue;
    }
    const processValue = process.env[key];
    if (processValue !== undefined) {
      merged[key] = processValue;
    }
  }
  return merged;
}

function hasConfiguredPluginEntries(config: OpenClawConfig): boolean {
  const entries = config.plugins?.entries;
  return (
    !!entries &&
    typeof entries === "object" &&
    !Array.isArray(entries) &&
    Object.keys(entries).length > 0
  );
}

function hasConfiguredChannelEntries(config: OpenClawConfig): boolean {
  const channels = config.channels;
  return (
    !!channels &&
    typeof channels === "object" &&
    !Array.isArray(channels) &&
    Object.keys(channels).some((channelId) => channelId !== "defaults")
  );
}

function createEmptyRuntimeWebToolsMetadata(): RuntimeWebToolsMetadata {
  return {
    search: {
      providerSource: "none",
      providerCount: 0,
      diagnostics: [],
    },
    fetch: {
      providerSource: "none",
      providerCount: 0,
      diagnostics: [],
    },
    diagnostics: [],
  };
}

export function createEmptySecretsRuntimeDiagnostics(): SecretsRuntimeDiagnostics {
  return {
    prepare: {
      envMs: 0,
      cloneMs: 0,
      authStoreLoadMs: 0,
      fastPathCheckMs: 0,
      importRuntimePrepareMs: 0,
      loadablePluginOriginsMs: 0,
      collectConfigAssignmentsMs: 0,
      collectAuthStoreAssignmentsMs: 0,
      resolveSecretRefsMs: 0,
      applyAssignmentsMs: 0,
      resolveWebToolsMs: 0,
      totalMs: 0,
      candidateAgentDirCount: 0,
      authStoreCount: 0,
      assignmentCount: 0,
      warningCount: 0,
      hasWebTools: false,
      webSearchProviderSource: "none",
      webFetchProviderSource: "none",
      webSearchProviderCount: 0,
      webFetchProviderCount: 0,
      webDiagnosticCount: 0,
    },
  };
}

function addPrepareDuration(
  diagnostics: SecretsRuntimeDiagnostics,
  key: keyof Pick<
    SecretsRuntimePrepareDiagnostics,
    | "envMs"
    | "cloneMs"
    | "authStoreLoadMs"
    | "fastPathCheckMs"
    | "importRuntimePrepareMs"
    | "loadablePluginOriginsMs"
    | "collectConfigAssignmentsMs"
    | "collectAuthStoreAssignmentsMs"
    | "resolveSecretRefsMs"
    | "applyAssignmentsMs"
    | "resolveWebToolsMs"
  >,
  durationMs: number,
): void {
  diagnostics.prepare[key] += durationMs;
}

function updatePrepareDiagnosticsFromSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): void {
  const prepare = snapshot.diagnostics.prepare;
  prepare.authStoreCount = snapshot.authStores.length;
  prepare.warningCount = snapshot.warnings.length;
  prepare.webSearchProviderSource = snapshot.webTools.search.providerSource;
  prepare.webFetchProviderSource = snapshot.webTools.fetch.providerSource;
  prepare.webSearchProviderCount = snapshot.webTools.search.providerCount ?? 0;
  prepare.webFetchProviderCount = snapshot.webTools.fetch.providerCount ?? 0;
  prepare.webDiagnosticCount =
    snapshot.webTools.diagnostics.length +
    snapshot.webTools.search.diagnostics.length +
    snapshot.webTools.fetch.diagnostics.length;
  prepare.hasWebTools =
    prepare.webSearchProviderSource !== "none" ||
    prepare.webFetchProviderSource !== "none" ||
    prepare.webDiagnosticCount > 0;
}

function prepareDiagnosticsAttributes(
  diagnostics: SecretsRuntimeDiagnostics,
): SecretsDiagnosticAttributes {
  const prepare = diagnostics.prepare;
  return {
    candidateAgentDirCount: prepare.candidateAgentDirCount,
    authStoreCount: prepare.authStoreCount,
    assignmentCount: prepare.assignmentCount,
    warningCount: prepare.warningCount,
    hasWebTools: prepare.hasWebTools,
    webSearchProviderSource: prepare.webSearchProviderSource,
    webFetchProviderSource: prepare.webFetchProviderSource,
    webSearchProviderCount: prepare.webSearchProviderCount,
    webFetchProviderCount: prepare.webFetchProviderCount,
    webDiagnosticCount: prepare.webDiagnosticCount,
  };
}

const WEB_FETCH_CREDENTIAL_FIELD_NAMES = new Set(["apikey", "key", "token", "secret", "password"]);

function hasCredentialBearingWebFetchValue(
  value: unknown,
  defaults: Parameters<typeof coerceSecretRef>[1],
  seen = new WeakSet<object>(),
): boolean {
  if (coerceSecretRef(value, defaults)) {
    return true;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => hasCredentialBearingWebFetchValue(entry, defaults, seen));
  }
  return Object.entries(value as Record<string, unknown>).some(([rawKey, entry]) => {
    const key = rawKey.toLowerCase();
    if (WEB_FETCH_CREDENTIAL_FIELD_NAMES.has(key) && entry != null && entry !== "") {
      return true;
    }
    return hasCredentialBearingWebFetchValue(entry, defaults, seen);
  });
}

function hasActiveRuntimeWebFetchProviderSurface(
  fetch: unknown,
  defaults: Parameters<typeof coerceSecretRef>[1],
): boolean {
  if (!fetch || typeof fetch !== "object" || Array.isArray(fetch)) {
    return false;
  }
  const fetchConfig = fetch as Record<string, unknown>;
  if (fetchConfig.enabled === false) {
    return false;
  }
  if (typeof fetchConfig.provider === "string" && fetchConfig.provider.trim()) {
    return true;
  }
  return hasCredentialBearingWebFetchValue(fetchConfig, defaults);
}

function hasRuntimeWebToolConfigSurface(config: OpenClawConfig): boolean {
  const web = config.tools?.web;
  const defaults = config.secrets?.defaults;
  const fetchExplicitlyDisabled =
    web &&
    typeof web === "object" &&
    !Array.isArray(web) &&
    typeof (web as Record<string, unknown>).fetch === "object" &&
    (web as { fetch?: { enabled?: unknown } }).fetch?.enabled === false;
  if (web && typeof web === "object" && !Array.isArray(web)) {
    const webRecord = web as Record<string, unknown>;
    if ("search" in webRecord || "x_search" in webRecord) {
      return true;
    }
    if (
      "fetch" in webRecord &&
      hasActiveRuntimeWebFetchProviderSurface(webRecord.fetch, defaults)
    ) {
      return true;
    }
  }
  const entries = config.plugins?.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return false;
  }
  return Object.values(entries).some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const pluginConfig = (entry as { config?: unknown }).config;
    return (
      !!pluginConfig &&
      typeof pluginConfig === "object" &&
      !Array.isArray(pluginConfig) &&
      ("webSearch" in pluginConfig || (!fetchExplicitlyDisabled && "webFetch" in pluginConfig))
    );
  });
}

function hasSecretRefCandidate(
  value: unknown,
  defaults: Parameters<typeof coerceSecretRef>[1],
  seen = new WeakSet<object>(),
): boolean {
  if (coerceSecretRef(value, defaults)) {
    return true;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => hasSecretRefCandidate(entry, defaults, seen));
  }
  return Object.values(value as Record<string, unknown>).some((entry) =>
    hasSecretRefCandidate(entry, defaults, seen),
  );
}

function canUseSecretsRuntimeFastPath(params: {
  sourceConfig: OpenClawConfig;
  authStores: Array<{ agentDir: string; store: AuthProfileStore }>;
}): boolean {
  if (hasRuntimeWebToolConfigSurface(params.sourceConfig)) {
    return false;
  }
  const defaults = params.sourceConfig.secrets?.defaults;
  if (hasSecretRefCandidate(params.sourceConfig, defaults)) {
    return false;
  }
  return !params.authStores.some((entry) => hasSecretRefCandidate(entry.store, defaults));
}

export async function prepareSecretsRuntimeSnapshot(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: string[];
  includeAuthStoreRefs?: boolean;
  loadAuthStore?: (agentDir?: string) => AuthProfileStore;
  /** Test override for discovered loadable plugins and their origins. */
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}): Promise<PreparedSecretsRuntimeSnapshot> {
  const diagnostics = createEmptySecretsRuntimeDiagnostics();
  return await measureSecretsDiagnosticsSpan(
    {
      name: "secrets.prepare.total",
      config: params.config,
      env: params.env,
      successAttributes: (snapshot, durationMs) => {
        snapshot.diagnostics.prepare.totalMs = durationMs;
        updatePrepareDiagnosticsFromSnapshot(snapshot);
        return prepareDiagnosticsAttributes(snapshot.diagnostics);
      },
    },
    async () => {
      const runtimeEnv = measureSecretsDiagnosticsSpanSync(
        {
          name: "secrets.prepare.env",
          config: params.config,
          env: params.env,
          onDuration: (durationMs) => addPrepareDuration(diagnostics, "envMs", durationMs),
        },
        () => mergeSecretsRuntimeEnv(params.env),
      );
      const [sourceConfig, resolvedConfig] = measureSecretsDiagnosticsSpanSync(
        {
          name: "secrets.prepare.clone",
          config: params.config,
          env: runtimeEnv,
          onDuration: (durationMs) => addPrepareDuration(diagnostics, "cloneMs", durationMs),
        },
        () => [structuredClone(params.config), structuredClone(params.config)] as const,
      );
      const includeAuthStoreRefs = params.includeAuthStoreRefs ?? true;
      let authStores: Array<{ agentDir: string; store: AuthProfileStore }> = [];
      const fastPathLoadAuthStore =
        params.loadAuthStore ?? loadAuthProfileStoreWithoutExternalProfiles;
      const candidateDirs = params.agentDirs?.length
        ? [...new Set(params.agentDirs.map((entry) => resolveUserPath(entry, runtimeEnv)))]
        : collectCandidateAgentDirs(resolvedConfig, runtimeEnv);
      diagnostics.prepare.candidateAgentDirCount = candidateDirs.length;
      if (includeAuthStoreRefs) {
        authStores = measureSecretsDiagnosticsSpanSync(
          {
            name: "secrets.prepare.authStoreLoad",
            config: sourceConfig,
            env: runtimeEnv,
            attributes: {
              candidateAgentDirCount: candidateDirs.length,
              loader: params.loadAuthStore ? "caller" : "withoutExternalProfiles",
            },
            onDuration: (durationMs) =>
              addPrepareDuration(diagnostics, "authStoreLoadMs", durationMs),
            successAttributes: (stores) => ({ authStoreCount: stores.length }),
          },
          () =>
            candidateDirs.map((agentDir) => ({
              agentDir,
              store: structuredClone(fastPathLoadAuthStore(agentDir)),
            })),
        );
        diagnostics.prepare.authStoreCount = authStores.length;
      }
      const useFastPath = measureSecretsDiagnosticsSpanSync(
        {
          name: "secrets.prepare.fastPathCheck",
          config: sourceConfig,
          env: runtimeEnv,
          attributes: {
            candidateAgentDirCount: candidateDirs.length,
            authStoreCount: authStores.length,
            hasWebTools: hasRuntimeWebToolConfigSurface(sourceConfig),
          },
          onDuration: (durationMs) =>
            addPrepareDuration(diagnostics, "fastPathCheckMs", durationMs),
          successAttributes: (enabled) => ({ enabled }),
        },
        () => canUseSecretsRuntimeFastPath({ sourceConfig, authStores }),
      );
      if (useFastPath) {
        const snapshot = {
          sourceConfig,
          config: resolvedConfig,
          authStores,
          warnings: [],
          webTools: createEmptyRuntimeWebToolsMetadata(),
          diagnostics,
        };
        updatePrepareDiagnosticsFromSnapshot(snapshot);
        preparedSnapshotRefreshContext.set(snapshot, {
          env: runtimeEnv,
          explicitAgentDirs: params.agentDirs?.length ? [...candidateDirs] : null,
          loadAuthStore: fastPathLoadAuthStore,
          loadablePluginOrigins: params.loadablePluginOrigins ?? new Map<string, PluginOrigin>(),
        });
        return snapshot;
      }

      const {
        applyResolvedAssignments,
        collectAuthStoreAssignments,
        collectConfigAssignments,
        createResolverContext,
        resolveRuntimeWebTools,
        resolveSecretRefValues,
      } = await measureSecretsDiagnosticsSpan(
        {
          name: "secrets.prepare.importRuntimePrepare",
          config: sourceConfig,
          env: runtimeEnv,
          onDuration: (durationMs) =>
            addPrepareDuration(diagnostics, "importRuntimePrepareMs", durationMs),
        },
        () => loadRuntimePrepareHelpers(),
      );
      const needsLoadablePluginOrigins =
        hasConfiguredPluginEntries(sourceConfig) || hasConfiguredChannelEntries(sourceConfig);
      const loadablePluginOrigins =
        params.loadablePluginOrigins ??
        (needsLoadablePluginOrigins
          ? await measureSecretsDiagnosticsSpan(
              {
                name: "secrets.prepare.loadablePluginOrigins",
                config: sourceConfig,
                env: runtimeEnv,
                attributes: { needsLoadablePluginOrigins },
                onDuration: (durationMs) =>
                  addPrepareDuration(diagnostics, "loadablePluginOriginsMs", durationMs),
                successAttributes: (origins) => ({ pluginOriginCount: origins.size }),
              },
              () => resolveLoadablePluginOrigins({ config: sourceConfig, env: runtimeEnv }),
            )
          : new Map<string, PluginOrigin>());
      const context = createResolverContext({
        sourceConfig,
        env: runtimeEnv,
      });

      measureSecretsDiagnosticsSpanSync(
        {
          name: "secrets.prepare.collectConfigAssignments",
          config: sourceConfig,
          env: runtimeEnv,
          attributes: { pluginOriginCount: loadablePluginOrigins.size },
          onDuration: (durationMs) =>
            addPrepareDuration(diagnostics, "collectConfigAssignmentsMs", durationMs),
          successAttributes: () => ({ assignmentCount: context.assignments.length }),
        },
        () =>
          collectConfigAssignments({
            config: resolvedConfig,
            context,
            loadablePluginOrigins,
          }),
      );

      if (includeAuthStoreRefs) {
        const loadAuthStore = params.loadAuthStore ?? loadAuthProfileStoreForSecretsRuntime;
        if (!params.loadAuthStore) {
          authStores = measureSecretsDiagnosticsSpanSync(
            {
              name: "secrets.prepare.authStoreLoad",
              config: sourceConfig,
              env: runtimeEnv,
              attributes: {
                candidateAgentDirCount: candidateDirs.length,
                loader: "secretsRuntime",
              },
              onDuration: (durationMs) =>
                addPrepareDuration(diagnostics, "authStoreLoadMs", durationMs),
              successAttributes: (stores) => ({ authStoreCount: stores.length }),
            },
            () =>
              candidateDirs.map((agentDir) => ({
                agentDir,
                store: structuredClone(loadAuthStore(agentDir)),
              })),
          );
          diagnostics.prepare.authStoreCount = authStores.length;
        }
        measureSecretsDiagnosticsSpanSync(
          {
            name: "secrets.prepare.collectAuthStoreAssignments",
            config: sourceConfig,
            env: runtimeEnv,
            attributes: { authStoreCount: authStores.length },
            onDuration: (durationMs) =>
              addPrepareDuration(diagnostics, "collectAuthStoreAssignmentsMs", durationMs),
            successAttributes: () => ({ assignmentCount: context.assignments.length }),
          },
          () => {
            for (const entry of authStores) {
              collectAuthStoreAssignments({
                store: entry.store,
                context,
                agentDir: entry.agentDir,
              });
            }
          },
        );
      }
      diagnostics.prepare.assignmentCount = context.assignments.length;

      if (context.assignments.length > 0) {
        const refs = context.assignments.map((assignment) => assignment.ref);
        const resolved = await measureSecretsDiagnosticsSpan(
          {
            name: "secrets.prepare.resolveSecretRefs",
            config: sourceConfig,
            env: runtimeEnv,
            attributes: { assignmentCount: refs.length },
            onDuration: (durationMs) =>
              addPrepareDuration(diagnostics, "resolveSecretRefsMs", durationMs),
          },
          () =>
            resolveSecretRefValues(refs, {
              config: sourceConfig,
              env: context.env,
              cache: context.cache,
            }),
        );
        measureSecretsDiagnosticsSpanSync(
          {
            name: "secrets.prepare.applyAssignments",
            config: sourceConfig,
            env: runtimeEnv,
            attributes: { assignmentCount: context.assignments.length },
            onDuration: (durationMs) =>
              addPrepareDuration(diagnostics, "applyAssignmentsMs", durationMs),
          },
          () =>
            applyResolvedAssignments({
              assignments: context.assignments,
              resolved,
            }),
        );
      }

      const webTools = await measureSecretsDiagnosticsSpan(
        {
          name: "secrets.prepare.resolveWebTools",
          config: sourceConfig,
          env: runtimeEnv,
          attributes: { hasWebTools: hasRuntimeWebToolConfigSurface(sourceConfig) },
          onDuration: (durationMs) =>
            addPrepareDuration(diagnostics, "resolveWebToolsMs", durationMs),
          successAttributes: (metadata) => ({
            webSearchProviderSource: metadata.search.providerSource,
            webFetchProviderSource: metadata.fetch.providerSource,
            webSearchProviderCount: metadata.search.providerCount ?? 0,
            webFetchProviderCount: metadata.fetch.providerCount ?? 0,
            webDiagnosticCount:
              metadata.diagnostics.length +
              metadata.search.diagnostics.length +
              metadata.fetch.diagnostics.length,
          }),
        },
        () =>
          resolveRuntimeWebTools({
            sourceConfig,
            resolvedConfig,
            context,
          }),
      );

      const snapshot = {
        sourceConfig,
        config: resolvedConfig,
        authStores,
        warnings: context.warnings,
        webTools,
        diagnostics,
      };
      updatePrepareDiagnosticsFromSnapshot(snapshot);
      preparedSnapshotRefreshContext.set(snapshot, {
        env: runtimeEnv,
        explicitAgentDirs: params.agentDirs?.length ? [...candidateDirs] : null,
        loadAuthStore: params.loadAuthStore ?? loadAuthProfileStoreForSecretsRuntime,
        loadablePluginOrigins,
      });
      return snapshot;
    },
  );
}

export function activateSecretsRuntimeSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): void {
  const next = cloneSnapshot(snapshot);
  const refreshContext =
    preparedSnapshotRefreshContext.get(snapshot) ??
    activeRefreshContext ??
    ({
      env: { ...process.env } as Record<string, string | undefined>,
      explicitAgentDirs: null,
      loadAuthStore: loadAuthProfileStoreForSecretsRuntime,
      loadablePluginOrigins: new Map<string, PluginOrigin>(),
    } satisfies SecretsRuntimeRefreshContext);
  setRuntimeConfigSnapshot(next.config, next.sourceConfig);
  replaceRuntimeAuthProfileStoreSnapshots(next.authStores);
  activeSnapshot = next;
  activeRefreshContext = cloneRefreshContext(refreshContext);
  setActiveRuntimeWebToolsMetadata(next.webTools);
  setRuntimeConfigSnapshotRefreshHandler({
    refresh: async ({ sourceConfig }) => {
      if (!activeSnapshot || !activeRefreshContext) {
        return false;
      }
      const refreshed = await prepareSecretsRuntimeSnapshot({
        config: sourceConfig,
        env: activeRefreshContext.env,
        agentDirs: resolveRefreshAgentDirs(sourceConfig, activeRefreshContext),
        loadAuthStore: activeRefreshContext.loadAuthStore,
        loadablePluginOrigins: activeRefreshContext.loadablePluginOrigins,
      });
      activateSecretsRuntimeSnapshot(refreshed);
      return true;
    },
  });
}

export async function refreshActiveSecretsRuntimeSnapshot(): Promise<boolean> {
  if (!activeSnapshot || !activeRefreshContext) {
    return false;
  }
  const refreshed = await prepareSecretsRuntimeSnapshot({
    config: activeSnapshot.sourceConfig,
    env: activeRefreshContext.env,
    agentDirs: resolveRefreshAgentDirs(activeSnapshot.sourceConfig, activeRefreshContext),
    loadAuthStore: activeRefreshContext.loadAuthStore,
    loadablePluginOrigins: activeRefreshContext.loadablePluginOrigins,
  });
  activateSecretsRuntimeSnapshot(refreshed);
  return true;
}

export function getActiveSecretsRuntimeSnapshot(): PreparedSecretsRuntimeSnapshot | null {
  if (!activeSnapshot) {
    return null;
  }
  const snapshot = cloneSnapshot(activeSnapshot);
  if (activeRefreshContext) {
    preparedSnapshotRefreshContext.set(snapshot, cloneRefreshContext(activeRefreshContext));
  }
  return snapshot;
}

export function getActiveRuntimeWebToolsMetadata(): RuntimeWebToolsMetadata | null {
  return getActiveRuntimeWebToolsMetadataFromState();
}

export function clearSecretsRuntimeSnapshot(): void {
  clearActiveSecretsRuntimeState();
}
