// Server entry: exposes the host's Kimi Code limits as a usage source for
// BB's built-in "Provider usage" view.
//
// The built-in provider-usage plugin discovers any loaded plugin that serves
// `provider-usage.v1.listResources` and `provider-usage.v1.getResource`:
// listResources declares the resources this plugin owns and getResource returns
// the live numbers for exactly one of them. Nothing here touches the provider
// itself, so it works beside the ACP-registry `acp-kimi-code` provider.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, type HostUsageResult } from "./contract.js";

/** Provider id used for grouping in the usage view. The built-in view falls
 * back to the provider id as the visible name when the provider itself does not
 * advertise usage support, so this string is what the user reads. */
const PROVIDER_ID = "Kimi Code";
/** Resource ids are namespaced and versioned so a changed payload shape gets a
 * fresh cache entry instead of a stale one. */
const RESOURCE_PREFIX = "host:v2:";

const windowKindSchema = z.enum(["five-hour", "daily", "weekly", "custom"]);

const usageWindowSchema = z.object({
  kind: windowKindSchema,
  id: z.string(),
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
  model: z.string().nullable(),
  cost: z
    .object({ usedUsdCents: z.number(), limitUsdCents: z.number() })
    .nullable(),
});

const planSchema = z.object({ id: z.string(), multiplier: z.number().nullable() });

const usageSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    plan: planSchema.nullable(),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
    windows: z.array(usageWindowSchema),
  }),
  z.object({
    status: z.literal("not_installed"),
    plan: planSchema.nullable(),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
  }),
  z.object({
    status: z.literal("unauthenticated"),
    plan: planSchema.nullable(),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
  }),
  z.object({
    status: z.literal("expired"),
    plan: planSchema.nullable(),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
  }),
  z.object({
    status: z.literal("error"),
    plan: planSchema.nullable(),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
    message: z.string(),
  }),
]);

const resourceSchema = z.object({
  accountKey: z.string().nullable(),
  id: z.string().min(1),
  providerId: z.string().min(1),
  label: z.string().min(1),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("shared") }),
    z.object({
      kind: z.literal("host"),
      hostId: z.string().min(1),
      hostName: z.string().min(1),
    }),
  ]),
});

export const usageRpc = defineRpcContract({
  "provider-usage.v1.listResources": {
    input: z.object({}).strict(),
    output: z.object({
      label: z.string().min(1).optional(),
      resources: z.array(resourceSchema),
    }),
  },
  "provider-usage.v1.getResource": {
    input: z.object({
      resourceId: z.string().min(1),
      refresh: z.boolean(),
    }),
    output: z.object({
      accountKey: z.string().nullable(),
      observedAt: z.number().int().nonnegative().nullable(),
      usage: usageSchema,
    }),
  },
});

type Usage = z.infer<typeof usageSchema>;

function emptyPlan(): null {
  return null;
}

function notMeasured(
  status: "not_installed" | "unauthenticated" | "expired",
): Usage {
  return { status, plan: emptyPlan(), accountEmail: null, planLabel: null };
}

type UsageWindow = z.infer<typeof usageWindowSchema>;

/** One host's answer, as the CLI prints it and as --json emits it. */
interface CliRow {
  host: string;
  hostId: string;
  observedAt: number | null;
  usage: Usage;
}

interface CliOptions {
  json: boolean;
  only: string | undefined;
}

function parseCliArgs(argv: readonly string[]): CliOptions {
  const index = argv.indexOf("--host");
  return {
    json: argv.includes("--json"),
    only: index >= 0 ? argv[index + 1] : undefined,
  };
}

function formatHeader(row: CliRow): string {
  const plan =
    row.usage.status === "ok" && row.usage.planLabel !== null
      ? ` [${row.usage.planLabel}]`
      : "";
  return `${row.host} (${row.hostId})${plan}`;
}

function formatWindow(window: UsageWindow): string {
  const reset =
    window.resetsAt === null
      ? "no reset reported"
      : `resets ${window.resetsAt}`;
  return `  ${window.label}: ${String(window.usedPercent)}% used, ${reset}`;
}

/** Header plus either the status line or the measured windows, in print order. */
function formatHostBlock(row: CliRow): string[] {
  if (row.usage.status !== "ok") {
    return [formatHeader(row), `  ${row.usage.status}`];
  }
  return [formatHeader(row), ...row.usage.windows.map(formatWindow)];
}

function formatReport(rows: readonly CliRow[]): string {
  if (rows.length === 0) return "No connected hosts.";
  return rows.flatMap(formatHostBlock).join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  const hostClient = bb.hosts.experimental_client({ contract: hostContract });

  async function connectedHosts(): Promise<
    Array<{ id: string; name: string }>
  > {
    const hosts = await bb.sdk.hosts.list({ includeCreating: false });
    return hosts
      .filter((host) => host.status === "connected" && host.type !== "ephemeral")
      .map((host) => ({ id: host.id, name: host.name }));
  }

  function usageFromHost(result: HostUsageResult): Usage {
    switch (result.status) {
      case "ok":
        return {
          status: "ok",
          plan: emptyPlan(),
          accountEmail: null,
          planLabel: result.planLabel,
          windows: result.windows.map((window) => ({
            kind: window.kind,
            id: window.id,
            label: window.label,
            usedPercent: window.usedPercent,
            resetsAt: window.resetsAt,
            model: null,
            cost: null,
          })),
        };
      case "not_installed":
      case "unauthenticated":
      case "expired":
        return notMeasured(result.status);
      default:
        return {
          status: "error",
          plan: emptyPlan(),
          accountEmail: null,
          planLabel: null,
          message: result.message ?? "Kimi usage could not be collected.",
        };
    }
  }

  async function collectForHost(
    hostId: string,
    refresh: boolean,
  ): Promise<{ observedAt: number | null; usage: Usage }> {
    try {
      const result = await hostClient.call(
        "collectUsage",
        { refresh },
        { hostId, signal: AbortSignal.timeout(60_000) },
      );
      return { observedAt: result.observedAt, usage: usageFromHost(result) };
    } catch (error) {
      return {
        observedAt: null,
        usage: {
          status: "error",
          plan: emptyPlan(),
          accountEmail: null,
          planLabel: null,
          message:
            error instanceof Error
              ? error.message
              : "Kimi usage could not be collected on that host.",
        },
      };
    }
  }

  bb.rpc.register(
    usageRpc,
    {
      "provider-usage.v1.listResources": async () => {
        const hosts = await connectedHosts();
        return {
          resources: hosts.map((host) => ({
            accountKey: null,
            id: `${RESOURCE_PREFIX}${host.id}`,
            providerId: PROVIDER_ID,
            label: "Kimi Code",
            scope: {
              kind: "host" as const,
              hostId: host.id,
              hostName: host.name,
            },
          })),
        };
      },
      "provider-usage.v1.getResource": async ({ resourceId, refresh }) => {
        if (!resourceId.startsWith(RESOURCE_PREFIX)) {
          throw new Error(`Unknown Kimi usage resource "${resourceId}".`);
        }
        const hostId = resourceId.slice(RESOURCE_PREFIX.length);
        const { observedAt, usage } = await collectForHost(hostId, refresh);
        return { accountKey: null, observedAt, usage };
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Kimi Code plan limits read from each host's Kimi CLI login",
    },
  );

  async function collectRows(only: string | undefined): Promise<CliRow[]> {
    const hosts = await connectedHosts();
    const targets =
      only === undefined ? hosts : hosts.filter((host) => host.id === only);
    const rows: CliRow[] = [];
    for (const host of targets) {
      const { observedAt, usage } = await collectForHost(host.id, true);
      rows.push({ host: host.name, hostId: host.id, observedAt, usage });
    }
    return rows;
  }

  // `bb kimi-usage` prints the same numbers from a terminal.
  bb.cli.register({
    name: "kimi-usage",
    summary: "Show Kimi Code plan limits per host",
    commands: [
      {
        name: "show",
        summary: "Show limits for every connected host",
        usage: "bb kimi-usage show [--host <id>] [--json]",
      },
    ],
    async run(argv) {
      const { json, only } = parseCliArgs(argv);
      const rows = await collectRows(only);
      if (json) {
        return { exitCode: 0, stdout: JSON.stringify({ hosts: rows }, null, 2) };
      }
      return { exitCode: 0, stdout: formatReport(rows) };
    },
  });
}
