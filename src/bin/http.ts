#!/usr/bin/env node
/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation
 *
 * See the NOTICE file(s) distributed with this work for additional
 * information regarding copyright ownership.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import { loadConfig } from "../config/load.js";
import { createHttpApp } from "../server/http-app.js";
import { buildKnowledgeService } from "../knowledge/build.js";
import { registerTools } from "../tools/index.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env.DITTO_MCP_CONFIG);
  const knowledge = await buildKnowledgeService(config);
  const registry = await registerTools(config, knowledge);
  const app = createHttpApp(config, registry);
  app.listen(config.server.http.port, config.server.http.host, () => {
    process.stderr.write(
      `[ditto-mcp] http server listening on ${config.server.http.host}:${config.server.http.port}/mcp\n`,
    );
  });
}

main().catch((err) => {
  process.stderr.write(`[ditto-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
