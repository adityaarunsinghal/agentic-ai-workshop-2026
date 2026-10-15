import { z } from "zod";

// UI navigation only, carried by the existing authenticated MCP frame transport.
export const OpenExecutionNotification = z.object({
  method: z.literal("notifications/workshop/open-execution"),
  params: z.object({
    recordId: z.string().max(256).nullable().default(null),
    taskId: z.string().max(256).default(""),
  }),
});
