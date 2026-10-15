// The plugin's version, read from its Claude manifest so there is one number to bump. Bump it
// whenever the server, skill, launcher, dependencies or driver pin change: Claude records it, and
// scripts/setup.ts compares it to tell an installed client that it's out of date.

import fs from "node:fs";

const manifest = new URL("../.claude-plugin/plugin.json", import.meta.url);
export const VERSION: string = (JSON.parse(fs.readFileSync(manifest, "utf8")) as { version: string }).version;
