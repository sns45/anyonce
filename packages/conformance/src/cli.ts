#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';
import { runConformance } from './conformance';
import type { ReportFormat } from './report';
import type { Capability, Tier } from './types';

const USAGE = `usage: anyonce-conformance --url <base> [--tier core|profile]... [--only <id>]... [--capability short-ttl]... [--ttl-ms <n>] [--report json|markdown|junit] [--out <file>]`;

interface Args {
  url?: string;
  tiers: Tier[];
  only: string[];
  capabilities: Capability[];
  ttlMs?: number;
  report: ReportFormat;
  out?: string;
}

export function parseArgs(input: string[]): Args | string {
  const args: Args = { tiers: [], only: [], capabilities: [], report: 'markdown' };
  for (let i = 0; i < input.length; i++) {
    const flag = input[i];
    const value = input[i + 1];
    if (flag === '--help' || flag === '-h') return USAGE;
    if (value === undefined) return `${flag} needs a value\n${USAGE}`;
    if (value.startsWith('--')) return `${flag} needs a value, got ${value}\n${USAGE}`;
    i++;
    switch (flag) {
      case '--url':
        args.url = value;
        break;
      case '--tier':
        if (value !== 'core' && value !== 'profile') return `unknown tier ${value}`;
        args.tiers.push(value);
        break;
      case '--only':
        args.only.push(value);
        break;
      case '--capability':
        if (value !== 'short-ttl') return `unknown capability ${value}`;
        args.capabilities.push(value);
        break;
      case '--ttl-ms':
        args.ttlMs = Number(value);
        if (!Number.isInteger(args.ttlMs) || args.ttlMs <= 0)
          return `--ttl-ms must be a positive integer`;
        break;
      case '--report':
        if (value !== 'json' && value !== 'markdown' && value !== 'junit')
          return `unknown report format ${value}`;
        args.report = value;
        break;
      case '--out':
        args.out = value;
        break;
      default:
        return `unknown flag ${flag}\n${USAGE}`;
    }
  }
  if (args.url === undefined) return `--url is required\n${USAGE}`;
  if (args.capabilities.includes('short-ttl') && args.ttlMs !== undefined && args.ttlMs > 2000) {
    return `short-ttl requires a target TTL of at most 2000 ms, got ${args.ttlMs}`;
  }
  return args;
}

async function main(): Promise<number> {
  const parsed = parseArgs(argv.slice(2));
  if (typeof parsed === 'string') {
    stderr.write(`${parsed}\n`);
    return 2;
  }
  const { summary, report } = await runConformance({
    target: { baseUrl: parsed.url as string },
    report: parsed.report,
    ...(parsed.tiers.length > 0 ? { tiers: parsed.tiers } : {}),
    ...(parsed.only.length > 0 ? { only: parsed.only } : {}),
    capabilities: parsed.capabilities,
  });
  if (parsed.out !== undefined) writeFileSync(parsed.out, report);
  else stdout.write(report);
  return summary.failed === 0 && summary.errored === 0 ? 0 : 1;
}

main().then(
  (code) => exit(code),
  (error: unknown) => {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    exit(2);
  },
);
