import { performance } from "node:perf_hooks";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getActiveDiagnosticsTimelineSpan,
  isDiagnosticsTimelineEnabled,
  measureDiagnosticsTimelineSpan,
  measureDiagnosticsTimelineSpanSync,
} from "../infra/diagnostics-timeline.js";

export type SecretsDiagnosticAttributes = Record<string, string | number | boolean | null>;

type MeasureSecretsSpanOptions<T> = {
  name: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  phase?: string;
  attributes?: SecretsDiagnosticAttributes;
  successAttributes?: (result: T, durationMs: number) => SecretsDiagnosticAttributes | undefined;
  errorAttributes?: (error: unknown, durationMs: number) => SecretsDiagnosticAttributes | undefined;
  onDuration?: (durationMs: number) => void;
};

function roundDurationMs(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(Math.max(0, value) * 1000) / 1000;
}

export async function measureSecretsDiagnosticsSpan<T>(
  options: MeasureSecretsSpanOptions<T>,
  run: () => Promise<T> | T,
): Promise<T> {
  const env = options.env ?? process.env;
  const startedAt = performance.now();
  const timelineEnabled = isDiagnosticsTimelineEnabled({ config: options.config, env });
  const activeSpan = timelineEnabled ? getActiveDiagnosticsTimelineSpan() : undefined;
  const phase = options.phase ?? activeSpan?.phase;
  try {
    const result = await (timelineEnabled
      ? measureDiagnosticsTimelineSpan(options.name, run, {
          config: options.config,
          env,
          phase,
          attributes: options.attributes,
          omitErrorMessage: true,
          successAttributes: (spanResult, spanDurationMs) => {
            const roundedDurationMs = roundDurationMs(spanDurationMs);
            options.onDuration?.(roundedDurationMs);
            return options.successAttributes?.(spanResult, roundedDurationMs);
          },
          errorAttributes: (error, spanDurationMs) => {
            const roundedDurationMs = roundDurationMs(spanDurationMs);
            options.onDuration?.(roundedDurationMs);
            return options.errorAttributes?.(error, roundedDurationMs);
          },
        })
      : run());
    const durationMs = roundDurationMs(performance.now() - startedAt);
    if (!timelineEnabled) {
      options.onDuration?.(durationMs);
      options.successAttributes?.(result, durationMs);
    }
    return result;
  } catch (error) {
    const durationMs = roundDurationMs(performance.now() - startedAt);
    if (!timelineEnabled) {
      options.onDuration?.(durationMs);
      options.errorAttributes?.(error, durationMs);
    }
    throw error;
  }
}

export function measureSecretsDiagnosticsSpanSync<T>(
  options: MeasureSecretsSpanOptions<T>,
  run: () => T,
): T {
  const env = options.env ?? process.env;
  const startedAt = performance.now();
  const timelineEnabled = isDiagnosticsTimelineEnabled({ config: options.config, env });
  const activeSpan = timelineEnabled ? getActiveDiagnosticsTimelineSpan() : undefined;
  const phase = options.phase ?? activeSpan?.phase;
  try {
    const result = timelineEnabled
      ? measureDiagnosticsTimelineSpanSync(options.name, run, {
          config: options.config,
          env,
          phase,
          attributes: options.attributes,
          omitErrorMessage: true,
          successAttributes: (spanResult, spanDurationMs) => {
            const roundedDurationMs = roundDurationMs(spanDurationMs);
            options.onDuration?.(roundedDurationMs);
            return options.successAttributes?.(spanResult, roundedDurationMs);
          },
          errorAttributes: (error, spanDurationMs) => {
            const roundedDurationMs = roundDurationMs(spanDurationMs);
            options.onDuration?.(roundedDurationMs);
            return options.errorAttributes?.(error, roundedDurationMs);
          },
        })
      : run();
    const durationMs = roundDurationMs(performance.now() - startedAt);
    if (!timelineEnabled) {
      options.onDuration?.(durationMs);
      options.successAttributes?.(result, durationMs);
    }
    return result;
  } catch (error) {
    const durationMs = roundDurationMs(performance.now() - startedAt);
    if (!timelineEnabled) {
      options.onDuration?.(durationMs);
      options.errorAttributes?.(error, durationMs);
    }
    throw error;
  }
}
