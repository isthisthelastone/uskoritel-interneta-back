import { loadEnvFromConfigFile } from "./src/config/loadEnv";
import { startServer } from "./src/server";

loadEnvFromConfigFile();
startServer();
