import type { PipelineStep } from "@alertforge/core";

/**
 * Placeholder fan-out-channels step. P3 lands this as a real package
 * boundary so consumers (worker, runPipeline at P3c) can reference the
 * step by name. The actual channel-iteration logic — load channel_configs
 * rows for the trigger, dispatch to adapter.send, record results in
 * ctx/notifications.json — ships in P5 when @alertforge/channel-slack and
 * @alertforge/channel-email exist.
 *
 * Until then the step is a no-op: it records "(channels not yet wired)"
 * into ctx so runPipeline still progresses + tests still verify the
 * pipeline reaches this step.
 */
export const fanOutChannelsStep: PipelineStep = {
  name: "fan-out-channels",
  description: "Send pipeline notification to every enabled channel for this trigger",
  async run(ctx) {
    await ctx.write("notifications", { placeholder: true, sent: 0 });
  },
};
