#!/usr/bin/env node
const { execSync } = require("child_process");
const fs = require("fs");

execSync("tsc", { stdio: "inherit" });

const cliPath = "dist/cli.js";
const content = fs.readFileSync(cliPath, "utf-8");
fs.writeFileSync(cliPath, "#!/usr/bin/env node\n" + content);
console.log("v Added shebang to " + cliPath);
