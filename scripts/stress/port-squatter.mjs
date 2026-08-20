#!/usr/bin/env node
/**
 * Occupy ports so the launcher's fallback logic can be exercised (M4 gate).
 *
 *   node scripts/stress/port-squatter.mjs 3000 3001 [--for 120]
 *
 * Holds plain TCP listeners (identifies itself as "port-squatter" in the
 * command line so the launcher must treat it as a NON-Docker, non-app holder:
 * on 3000 that means "refuse and explain"; on 3001 it means "move the API to
 * 3005–3008"). Exits after --for seconds (default 300) or on Ctrl-C.
 */
import net from "node:net";

const ports = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
const forIdx = process.argv.indexOf("--for");
const seconds = forIdx > 0 ? parseInt(process.argv[forIdx + 1], 10) : 300;
if (!ports.length) { console.log("usage: port-squatter.mjs <port> [port…] [--for seconds]"); process.exit(2); }

const servers = [];
for (const port of ports) {
  const srv = net.createServer((sock) => sock.end("port-squatter\n"));
  srv.on("error", (e) => { console.log(`✗ could not bind ${port}: ${e.message}`); });
  srv.listen(port, "0.0.0.0", () => console.log(`▶ squatting on :${port} (pid ${process.pid})`));
  servers.push(srv);
}
setTimeout(() => { console.log("▶ releasing ports"); servers.forEach((s) => s.close()); }, seconds * 1000).unref();
process.on("SIGINT", () => { servers.forEach((s) => s.close()); process.exit(0); });
