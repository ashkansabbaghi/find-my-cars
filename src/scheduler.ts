import { schedule, validate, type ScheduledTask } from "node-cron";

export function startScheduler(
  cronExpression: string,
  onTick: () => Promise<void>,
): ScheduledTask {
  if (!validate(cronExpression)) {
    throw new Error(`invalid CRON_SCHEDULE: ${cronExpression}`);
  }

  const task = schedule(
    cronExpression,
    async () => {
      try {
        await onTick();
      } catch (err) {
        console.error("[scheduler] cycle failed:", err);
      }
    },
    {
      name: "divar-monitor",
      noOverlap: true,
    },
  );

  console.info(`[scheduler] started with schedule "${cronExpression}"`);
  return task;
}

export async function stopScheduler(task: ScheduledTask): Promise<void> {
  await task.stop();
  await task.destroy();
  console.info("[scheduler] stopped");
}
