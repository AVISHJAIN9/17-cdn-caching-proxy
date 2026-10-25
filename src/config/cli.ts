import fs from 'node:fs';
import path from 'node:path';
import { parseOriginsConfig, redactConfig } from './origins.js';

export function runConfigCheck(configPath?: string): number {
  let rawConfig: any = {};

  if (configPath) {
    const resolvedPath = path.resolve(process.cwd(), configPath);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`Config file not found: ${resolvedPath}`);
      return 1;
    }
    try {
      const content = fs.readFileSync(resolvedPath, 'utf-8');
      rawConfig = JSON.parse(content);
    } catch (err: any) {
      console.error(`Error parsing config file: ${err.message}`);
      return 1;
    }
  }

  try {
    const effective = parseOriginsConfig(rawConfig);
    const redacted = redactConfig(effective);
    console.log('Effective configuration (redacted):');
    console.log(JSON.stringify(redacted, null, 2));
    return 0;
  } catch (err: any) {
    console.error('Configuration validation failed:');
    console.error(err.message);
    return 1;
  }
}

// If invoked from CLI
if (process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  const targetPath = process.argv[2];
  const code = runConfigCheck(targetPath);
  process.exit(code);
}
