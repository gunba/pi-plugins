#!/usr/bin/env node
import { runRelay } from "./relay-server.ts";
await runRelay(process.argv.slice(2));
