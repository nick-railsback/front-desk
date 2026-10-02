import { App } from 'aws-cdk-lib';
import { FrontDeskStack } from '../lib/front-desk-stack.ts';

const app = new App();
new FrontDeskStack(app, 'FrontDesk', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
});
