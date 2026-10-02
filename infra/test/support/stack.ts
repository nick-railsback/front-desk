// Loads the infrastructure stack once and synthesizes it in-process, with a
// fictional account and no cloud session, network, or Docker. Not a test file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNT, REGION, type Cfn, ofType } from './cfn';

export const INFRA = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const ROOT = path.resolve(INFRA, '..');
export const STACK_MODULE = 'infra/lib/front-desk-stack.ts';

let cached: Promise<Cfn> | null = null;

// The feature flags `cdk synth` would use, so the template under test has the
// same shape as the one that gets deployed.
function cdkContext(): Record<string, unknown> {
  const file = path.join(INFRA, 'cdk.json');
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8')).context ?? {};
}

async function synthesize(): Promise<Cfn> {
  if (!fs.existsSync(path.join(ROOT, STACK_MODULE))) {
    throw new Error(`${STACK_MODULE} does not exist, so there is no stack to check`);
  }
  const mod = await import('../../lib/front-desk-stack');
  const StackClass = mod.FrontDeskStack;
  if (typeof StackClass !== 'function') {
    throw new Error(`${STACK_MODULE} does not export a FrontDeskStack class`);
  }
  const { App } = await import('aws-cdk-lib');
  const { Template } = await import('aws-cdk-lib/assertions');
  const app = new App({ context: cdkContext() });
  const stack = new StackClass(app, 'FrontDesk', { env: { account: ACCOUNT, region: REGION } });
  const template = Template.fromStack(stack).toJSON() as Cfn;
  // Nested stacks are separate templates; scans of this one would miss them.
  const nested = ofType(template, 'AWS::CloudFormation::Stack').map(([id]) => id);
  if (nested.length > 0) {
    throw new Error(`the stack contains nested stacks (${nested.join(', ')}), which these checks cannot see into`);
  }
  return template;
}

export function stackTemplate(): Promise<Cfn> {
  cached ??= synthesize();
  return cached;
}

export function readRepoFile(rel: string): string {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) throw new Error(`${rel} does not exist`);
  return fs.readFileSync(file, 'utf8');
}
