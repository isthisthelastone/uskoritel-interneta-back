import { createApp } from "./app";
import { startVpsConnectionsSyncJob } from "./services/vpsConnectionsSyncService";

function getPort(): number {
  const rawPort = process.env.PORT ?? "3000";
  const parsedPort = Number.parseInt(rawPort, 10);

  if (!Number.isFinite(parsedPort) || parsedPort <= 0) {
    return 3000;
  }

  return parsedPort;
}

export function startServer(): void {
  const app = createApp();
  const port = getPort();

  startVpsConnectionsSyncJob();

  app.listen(port, () => {
    console.log("Backend is running on http://localhost:" + String(port));
  });
}
