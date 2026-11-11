// Shared contract between the server entry and the host entry.
//
// The host entry runs on every enrolled host daemon: it is the only place that
// can see that machine's Kimi Code CLI installation, its OAuth credentials and
// its outbound network. The server entry turns those host answers into the
// `provider-usage.v1.*` RPC resources that BB's Provider usage view reads.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const windowKindSchema = z.enum([
  "five-hour",
  "daily",
  "weekly",
  "custom",
]);

export const hostWindowSchema = z
  .object({
    /** Stable id inside this resource, for example "limit_5h". */
    id: z.string(),
    label: z.string(),
    kind: windowKindSchema,
    usedPercent: z.number(),
    /** ISO timestamp, or null when the API reports no reset. */
    resetsAt: z.string().nullable(),
  })
  .strict();

export type HostWindow = z.infer<typeof hostWindowSchema>;

export const hostUsageResultSchema = z
  .object({
    status: z.enum([
      "ok",
      "not_installed",
      "unauthenticated",
      "expired",
      "error",
    ]),
    /** Human-readable failure detail; null unless status is "error". */
    message: z.string().nullable(),
    /** API base the numbers came from, for example https://api.kimi.ai/coding/v1. */
    baseUrl: z.string().nullable(),
    /** Plan name the account is on, for example "Ultra"; null when unknown. */
    planLabel: z.string().nullable(),
    windows: z.array(hostWindowSchema),
    /** Epoch milliseconds of the successful measurement, or null. */
    observedAt: z.number().nullable(),
  })
  .strict();

export type HostUsageResult = z.infer<typeof hostUsageResultSchema>;

export const hostContract = defineRpcContract({
  collectUsage: {
    input: z.object({ refresh: z.boolean() }).strict(),
    output: hostUsageResultSchema,
  },
});

export type HostContract = typeof hostContract;
