import { buildApp } from "./app.js";
import { loadConfig } from "./config/config.js";

const cfg = loadConfig();
const app = buildApp();

const host = cfg.HOST;
const port = cfg.PORT;

app
  .listen({ host, port })
  .then((addr) => {
    app.log.info(`Web proxy listening on ${addr}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
