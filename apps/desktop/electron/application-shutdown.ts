export type ApplicationShutdownTask = {
  name: string;
  run(): void | Promise<void>;
};

export type ApplicationShutdownResult = {
  timedOut: string[];
  failures: Array<{ name: string; message: string }>;
};

export async function shutdownApplication(
  tasks: ApplicationShutdownTask[],
  timeoutMs = 5_000,
): Promise<ApplicationShutdownResult> {
  const pending = new Set(tasks.map((task) => task.name));
  const failures: ApplicationShutdownResult["failures"] = [];
  const operations = tasks.map(async (task) => {
    try {
      await task.run();
    } catch (error) {
      failures.push({ name: task.name, message: error instanceof Error ? error.message : String(error) });
    } finally {
      pending.delete(task.name);
    }
  });

  let watchdog: NodeJS.Timeout | undefined;
  let watchdogExpired = false;
  await Promise.race([
    Promise.allSettled(operations),
    new Promise<void>((resolve) => {
      watchdog = setTimeout(() => {
        watchdogExpired = true;
        resolve();
      }, Math.max(0, timeoutMs));
    }),
  ]);
  if (watchdog) clearTimeout(watchdog);
  return { timedOut: watchdogExpired ? [...pending] : [], failures };
}
