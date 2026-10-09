import { config } from "./config.js";
import { migrate } from "./migrate.js";
import { createApp } from "./app.js";

await migrate();
createApp().listen(config.port, () => {
  console.log(`api listening on :${config.port}`);
});
