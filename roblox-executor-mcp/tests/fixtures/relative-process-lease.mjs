import path from "node:path";
import { acquireProcessLease } from "../../dist/decompiler/local-process-lifetime.js";

const root = process.argv[2];
const paths = {
  leases: path.join(root, "leases"),
  providers: path.join(root, "providers"),
};

const selfOperations = {
  snapshot(pid) {
    if (pid !== process.pid) return null;
    return {
      commandLine: process.argv.join(" "),
      startToken: `fixture:${process.pid}`,
    };
  },
  terminate() {},
  wait() {},
};

if (!acquireProcessLease(process.pid, "", paths, selfOperations)) {
  process.exit(1);
}

console.log("lease-ready");
setInterval(() => undefined, 1_000);
