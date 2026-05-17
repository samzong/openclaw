import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { __testing } from "../../scripts/bench-gateway-startup.ts";

async function listenOnLoopback(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("expected loopback port");
  }
  return { port: address.port, server };
}

describe("gateway startup benchmark script", () => {
  it("prints help without running benchmark cases", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/bench-gateway-startup.ts", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_NO_WARNINGS: "1",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OpenClaw Gateway startup benchmark");
    expect(result.stdout).toContain("--case <id>");
    expect(result.stdout).toContain("--cpu-prof-dir <dir>");
    expect(result.stdout).toContain("default (gateway default)");
    expect(result.stdout).toContain("gatewayAuthEnvSecretRef (gateway auth env SecretRef)");
    expect(result.stdout).toContain("slowExecSecretRef (slow exec SecretRef)");
    expect(result.stdout).not.toContain("[gateway-startup-bench]");
    expect(result.stderr).toBe("");
  });

  it("classifies HTTP listen and gateway ready logs separately", () => {
    expect(
      __testing.classifyGatewayReadyLog("[gateway] http server listening (0 plugins, 0.8s)"),
    ).toBe("http-listen");
    expect(__testing.classifyGatewayReadyLog("[gateway] ready (0 plugins, 0.8s)")).toBe(
      "gateway-ready",
    );
    expect(__testing.classifyGatewayReadyLog("[gateway] ready")).toBe("gateway-ready");
    expect(__testing.classifyGatewayReadyLog("[gateway] starting HTTP server...")).toBeNull();
  });

  it("summarizes split ready log timings without the ambiguous readyLogMs field", () => {
    const result = __testing.summarizeCase({ config: {}, id: "demo", name: "demo" }, [
      {
        cpuCoreRatio: null,
        cpuMs: null,
        exitCode: null,
        firstOutputMs: 1,
        gatewayReadyLogLine: "[gateway] ready",
        gatewayReadyLogMs: 40,
        healthz: {
          firstErrorKind: "econnrefused",
          firstRecoveryMs: 20,
          ms: 20,
          status: 200,
          transitions: [],
        },
        httpListenLogLine: "[gateway] http server listening (0 plugins)",
        httpListenLogMs: 10,
        maxRssMb: null,
        outputTail: "",
        readyz: {
          firstErrorKind: "http-503",
          firstRecoveryMs: 30,
          ms: 30,
          status: 200,
          transitions: [],
        },
        signal: null,
        startupTrace: {},
      },
    ]);

    expect(result.summary.httpListenLogMs?.p50).toBe(10);
    expect(result.summary.gatewayReadyLogMs?.p50).toBe(40);
    expect("readyLogMs" in result.summary).toBe(false);
  });

  it("collects Count-suffixed startup trace metrics", () => {
    const startupTrace: Record<string, number> = {};

    __testing.collectStartupTrace(
      "[gateway] startup trace: sidecars.acp.runtime-ready ready=1 readyCount=1 backend=acpx",
      startupTrace,
    );

    expect(startupTrace["sidecars.acp.runtime-ready.ready"]).toBeUndefined();
    expect(startupTrace["sidecars.acp.runtime-ready.readyCount"]).toBe(1);
  });

  it("collects secrets startup trace aggregate metrics", () => {
    const startupTrace: Record<string, number> = {};

    __testing.collectStartupTrace(
      "[gateway] startup trace: secrets.prepare totalMs=12.3 authStoreLoadMs=2.0 assignmentCount=3 hasWebToolsCount=1",
      startupTrace,
    );
    __testing.collectStartupTrace(
      "[gateway] startup trace: secrets.webTools totalMs=4.5 searchProviderCount=2 diagnosticCount=1",
      startupTrace,
    );

    expect(startupTrace["secrets.prepare.totalMs"]).toBe(12.3);
    expect(startupTrace["secrets.prepare.authStoreLoadMs"]).toBe(2);
    expect(startupTrace["secrets.prepare.assignmentCount"]).toBe(3);
    expect(startupTrace["secrets.prepare.hasWebToolsCount"]).toBe(1);
    expect(startupTrace["secrets.webTools.totalMs"]).toBe(4.5);
    expect(startupTrace["secrets.webTools.searchProviderCount"]).toBe(2);
    expect(startupTrace["secrets.webTools.diagnosticCount"]).toBe(1);
  });

  it("reads sanitized secrets diagnostics timeline entries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bench-timeline-test-"));
    try {
      const timelinePath = path.join(root, "timeline.jsonl");
      fs.writeFileSync(
        timelinePath,
        [
          JSON.stringify({
            type: "span.end",
            name: "secrets.resolve.provider",
            phase: "startup",
            durationMs: 253.4,
            attributes: {
              source: "exec",
              providerHash: "abcd1234",
              refCount: 1,
              ok: true,
            },
          }),
          JSON.stringify({
            type: "span.end",
            name: "plugins.metadata.scan",
            durationMs: 5,
          }),
          "",
        ].join("\n"),
      );

      expect(__testing.readSecretsDiagnosticsTimeline(timelinePath)).toEqual([
        {
          attributes: {
            source: "exec",
            providerHash: "abcd1234",
            refCount: 1,
            ok: true,
          },
          durationMs: 253.4,
          name: "secrets.resolve.provider",
          phase: "startup",
          type: "span.end",
        },
      ]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("records probe state transitions, first error kind, and first recovery", async () => {
    let calls = 0;
    const { port, server } = await listenOnLoopback((_req, res) => {
      calls += 1;
      res.statusCode = calls === 1 ? 503 : 200;
      res.end("ok");
    });
    try {
      const startAt = performance.now();
      const result = await __testing.waitForProbe({
        deadlineAt: startAt + 1_000,
        path: "/readyz",
        port,
        startAt,
      });

      expect(result.status).toBe(200);
      expect(result.ms).toEqual(expect.any(Number));
      expect(result.firstErrorKind).toBe("http-503");
      expect(result.firstRecoveryMs).toEqual(expect.any(Number));
      expect(result.transitions.map((transition) => transition.status)).toEqual([503, 200]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("writes 50-plugin fixtures as a parent load path with explicit startup activation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bench-config-test-"));
    try {
      const configPath = __testing.writeConfig(root, {
        config: {},
        id: "fiftyPlugins",
        name: "gateway, 50 manifest plugins",
        pluginActivationOnStartup: true,
        pluginCount: 2,
      });
      const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        plugins?: { allow?: string[]; load?: { paths?: string[] } };
      };

      expect(config.plugins?.load?.paths).toEqual([path.join(root, "plugins")]);
      expect(config.plugins?.allow).toEqual(["bench-plugin-01", "bench-plugin-02"]);
      const manifest = JSON.parse(
        fs.readFileSync(
          path.join(root, "plugins", "bench-plugin-01", "openclaw.plugin.json"),
          "utf8",
        ),
      ) as { activation?: { onStartup?: boolean } };
      expect(manifest.activation?.onStartup).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("merges benchmark case setup config and env into the generated config", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bench-config-test-"));
    try {
      const fixture = __testing.prepareCaseFixture(root, {
        config: {
          gateway: { mode: "local" },
        },
        id: "fixture",
        name: "fixture",
        setup: () => ({
          config: {
            gateway: { auth: { mode: "token", token: "bench-token" } },
            models: { providers: { openai: { apiKey: "bench-key" } } },
          },
          env: { BENCH_EXTRA: "1" },
        }),
      });
      const configPath = __testing.writeConfig(
        root,
        {
          config: {
            gateway: { mode: "local" },
          },
          id: "fixture",
          name: "fixture",
        },
        fixture.config,
      );
      const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        gateway?: { auth?: { token?: string }; mode?: string };
        models?: { providers?: { openai?: { apiKey?: string } } };
      };

      expect(fixture.env).toEqual({ BENCH_EXTRA: "1" });
      expect(config.gateway?.mode).toBe("local");
      expect(config.gateway?.auth?.token).toBe("bench-token");
      expect(config.models?.providers?.openai?.apiKey).toBe("bench-key");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("keeps startup-lazy plugin fixtures opted out of startup activation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bench-config-test-"));
    try {
      __testing.writeConfig(root, {
        config: {},
        id: "fiftyStartupLazyPlugins",
        name: "gateway, 50 startup-lazy manifest plugins",
        pluginActivationOnStartup: false,
        pluginCount: 1,
      });
      const manifest = JSON.parse(
        fs.readFileSync(
          path.join(root, "plugins", "bench-plugin-01", "openclaw.plugin.json"),
          "utf8",
        ),
      ) as { activation?: { onStartup?: boolean } };
      expect(manifest.activation?.onStartup).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
