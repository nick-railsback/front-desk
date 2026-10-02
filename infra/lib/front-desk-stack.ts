import { CfnOutput, CfnParameter, Duration, Fn, Stack, Tags } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';
const COMPOSE_VERSION = 'v5.6.0';
const COMPOSE_SHA256 = '40343e21ca777173e69cff5dbafeb37c6f81f3b0d57d9e597f036e95eb63e76a';
const COMPOSE_PLUGIN = '/usr/local/lib/docker/cli-plugins/docker-compose';

// The CDN adds the CSP only when the app sends none (override: false), so the
// app can ship its own nonce-based policy later without a stack change.
const FALLBACK_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export class FrontDeskStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const modelId: string = this.node.getContext('modelId');
    const foundationModelId: string = this.node.getContext('foundationModelId');
    const modelRegions: string[] = this.node.getContext('modelRegions');
    const githubRepo: string = this.node.getContext('githubRepo');
    const githubRepoImmutable: string = this.node.getContext('githubRepoImmutable');
    const cloudFrontPrefixListId: string = this.node.getContext('cloudFrontPrefixListId');

    // Passed at deploy time so the address never enters the repository.
    const alertEmail = new CfnParameter(this, 'AlertEmail', {
      type: 'String',
      description: 'Address that receives the budget alert',
    });

    // The inference profile plus the foundation model in every region it
    // routes to. Literal partition so the ARNs read as exact strings.
    const modelArns = [
      `arn:aws:bedrock:us-east-1:${this.account}:inference-profile/${modelId}`,
      ...modelRegions.map((region) => `arn:aws:bedrock:${region}::foundation-model/${foundationModelId}`),
    ];

    const repository = new ecr.Repository(this, 'AppRepository', {
      repositoryName: 'front-desk-app',
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 10 }],
    });

    const logGroup = new logs.LogGroup(this, 'AppLogs', {
      logGroupName: '/front-desk/app',
      retention: logs.RetentionDays.TWO_WEEKS,
    });

    // The app host's role: Session Manager, the one model, image pulls, logs.
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    instanceRole.addToPolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: modelArns }));
    repository.grantPull(instanceRole);
    logGroup.grantWrite(instanceRole);

    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { isDefault: true });

    // Only CloudFront's origin-facing addresses reach the host, on port 80.
    const securityGroup = new ec2.SecurityGroup(this, 'AppSecurityGroup', {
      vpc,
      description: 'Front desk app host: HTTP from CloudFront only',
      allowAllOutbound: true,
    });
    securityGroup.addIngressRule(ec2.Peer.prefixList(cloudFrontPrefixListId), ec2.Port.tcp(80), 'CloudFront origin-facing');

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'dnf install -y docker',
      'systemctl enable --now docker',
      `mkdir -p ${COMPOSE_PLUGIN.slice(0, COMPOSE_PLUGIN.lastIndexOf('/'))}`,
      `curl -fsSL -o ${COMPOSE_PLUGIN} https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64`,
      `echo "${COMPOSE_SHA256}  ${COMPOSE_PLUGIN}" | sha256sum -c - || exit 1`,
      `chmod 755 ${COMPOSE_PLUGIN}`,
      'mkdir -p /etc/frontdesk /opt/frontdesk',
      'if [ ! -f /etc/frontdesk/db.env ]; then (umask 077 && echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > /etc/frontdesk/db.env); fi',
      'chmod 600 /etc/frontdesk/db.env',
    );

    const instance = new ec2.Instance(this, 'AppHost', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      associatePublicIpAddress: true,
      instanceType: new ec2.InstanceType('t3.small'),
      // Cached in cdk.context.json so a newer AMI never replaces the host and
      // its database volume on a later deploy.
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cachedInContext: true }),
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(20, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true }),
        },
      ],
      // IMDSv2 only. CDK refuses requireImdsv2 alongside a hop limit, so the
      // same setting is spelled as httpTokens.
      httpTokens: ec2.HttpTokens.REQUIRED,
      // Containers on the Docker bridge are one hop further from the metadata
      // service; at the default of 1 the app cannot get the role's credentials.
      httpPutResponseHopLimit: 2,
      role: instanceRole,
      securityGroup,
      userData,
    });
    Tags.of(instance).add('app', 'front-desk');

    // A fixed address, so the CDN origin survives an instance stop and start.
    const eip = new ec2.CfnEIP(this, 'AppAddress', { domain: 'vpc', instanceId: instance.instanceId });
    const originDomain = Fn.join('', [
      'ec2-',
      Fn.join('-', Fn.split('.', eip.attrPublicIp)),
      '.compute-1.amazonaws.com',
    ]);

    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        contentSecurityPolicy: { contentSecurityPolicy: FALLBACK_CSP, override: false },
      },
    });

    const origin = new origins.HttpOrigin(originDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
    });

    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: headers,
      },
      additionalBehaviors: {
        '/_next/static/*': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: headers,
        },
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    const github = new iam.OidcProviderNative(this, 'GitHubOidc', {
      url: `https://${GITHUB_OIDC_HOST}`,
      clientIds: ['sts.amazonaws.com'],
    });
    // GitHub signs this repo's tokens with the immutable subject, which names
    // the owner and repository by ID. The name form is trusted alongside it
    // (DESIGN section 9).
    const subjectsFor = (context: string) => [githubRepo, githubRepoImmutable].map((repo) => `repo:${repo}:${context}`);
    const githubPrincipal = (subjects: string[]) =>
      new iam.WebIdentityPrincipal(github.openIdConnectProviderArn, {
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com',
          [`${GITHUB_OIDC_HOST}:sub`]: subjects,
        },
      });

    // CI eval role: pull requests and main may call the one model, nothing else.
    const evalRole = new iam.Role(this, 'EvalRole', {
      roleName: 'fd-eval',
      assumedBy: githubPrincipal([...subjectsFor('pull_request'), ...subjectsFor('ref:refs/heads/main')]),
    });
    evalRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: modelArns,
      }),
    );

    // CI deploy role: only the production environment; pushes images and
    // runs the rollout command on the tagged host.
    const deployRole = new iam.Role(this, 'DeployRole', {
      roleName: 'fd-deploy',
      assumedBy: githubPrincipal(subjectsFor('environment:production')),
    });
    repository.grantPullPush(deployRole);
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: [`arn:aws:ec2:us-east-1:${this.account}:instance/*`],
        conditions: { StringEquals: { 'ssm:resourceTag/app': 'front-desk' } },
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: ['arn:aws:ssm:us-east-1::document/AWS-RunShellScript'],
      }),
    );
    deployRole.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:ListCommandInvocations'], resources: ['*'] }));

    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'front-desk-monthly',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: 25, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: alertEmail.valueAsString }],
        },
      ],
    });

    new CfnOutput(this, 'AppUrl', { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn });
    new CfnOutput(this, 'EvalRoleArn', { value: evalRole.roleArn });
    new CfnOutput(this, 'RepositoryUri', { value: repository.repositoryUri });
    new CfnOutput(this, 'InstanceId', { value: instance.instanceId });
  }
}
