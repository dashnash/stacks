import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import type { Construct } from 'constructs';
import { bootstrapQualifier, envTag, stackName, STAGING_BOUNDARY_NAME, type EnvConfig, type EnvName } from './config';

/**
 * Viewer-request function for an old root: every request is answered with a 301 to the same
 * host label, path and query on the new root. The bare old root goes to `auth.<newRoot>` (where
 * the bare new root would send it anyway). Any other host (several labels, odd characters, a
 * lookalike such as `<oldRoot>.evil.example`) goes to the portal's front page, never to a host
 * built from it. Nothing else is served: no content, no API, no apple-app-site-association.
 */
export const legacyRedirectCode = (oldRoot: string, newRoot: string) => `
function handler(event) {
  var request = event.request;
  var host = ((request.headers.host && request.headers.host.value) || '').toLowerCase();
  var oldRoot = ${JSON.stringify(oldRoot)};
  var suffix = '.' + oldRoot;
  var label = host === oldRoot ? 'auth' : host.length > suffix.length && host.slice(-suffix.length) === suffix ? host.slice(0, -suffix.length) : '';
  var location = 'https://auth.' + ${JSON.stringify(newRoot)} + '/';
  if (/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
    location = 'https://' + label + '.' + ${JSON.stringify(newRoot)} + request.uri;
    var parts = [];
    var qs = request.querystring || {};
    for (var key in qs) {
      var values = qs[key].multiValue ? qs[key].multiValue : [qs[key]];
      for (var i = 0; i < values.length; i++) parts.push(values[i].value === '' ? key : key + '=' + values[i].value);
    }
    if (parts.length) location += '?' + parts.join('&');
  }
  return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: location }, 'cache-control': { value: 'public, max-age=86400' } } };
}`;

export interface LegacyRedirectStackProps {
  envName: EnvName;
  env: EnvConfig;
  region: string;
}

/**
 * `stacks-<env>-legacy-redirect`: one CloudFront distribution per entry in the environment's
 * `legacyRedirects`, holding `<oldRoot>` and `*.<oldRoot>`, or only `<label>.<oldRoot>` for each of
 * its `hosts` (its own certificate and alias records in the old zone), and answering everything
 * with `legacyRedirectCode`. Deploy it after the
 * platform and app stacks have left the old names (infra/bin/stacks.ts adds those dependencies).
 */
export class LegacyRedirectStack extends cdk.Stack {
  constructor(scope: Construct, props: LegacyRedirectStackProps) {
    const { envName, env } = props;
    super(scope, stackName(envName, 'legacy-redirect'), {
      env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: props.region },
      synthesizer: new cdk.DefaultStackSynthesizer({ qualifier: bootstrapQualifier(envName) }),
      description: `Stacks legacy-domain redirects (${envName})`,
    });
    cdk.Tags.of(this).add('stacks:env', envName);
    if (envName !== 'production') iam.PermissionsBoundary.of(this).apply(iam.ManagedPolicy.fromManagedPolicyName(this, 'Boundary', STAGING_BOUNDARY_NAME));

    for (const [i, old] of (env.legacyRedirects ?? []).entries()) {
      const id = `Legacy${i}`;
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, `${id}Zone`, { hostedZoneId: old.hostedZoneId, zoneName: old.hostedZoneName ?? old.rootDomain });
      const records: Array<readonly [string, string]> = old.hosts?.length
        ? old.hosts.map((h, j) => [`Host${j}`, `${h}.${old.rootDomain}`] as const)
        : [['Apex', old.rootDomain], ['Wildcard', `*.${old.rootDomain}`]];
      const names = records.map(([, name]) => name);
      const certificate = new acm.Certificate(this, `${id}Certificate`, {
        domainName: names[0]!,
        subjectAlternativeNames: names.length > 1 ? names.slice(1) : undefined,
        validation: acm.CertificateValidation.fromDns(zone),
      });
      const fn = new cloudfront.Function(this, `${id}Function`, {
        runtime: cloudfront.FunctionRuntime.JS_2_0,
        code: cloudfront.FunctionCode.fromInline(legacyRedirectCode(old.rootDomain, env.rootDomain)),
      });
      const distribution = new cloudfront.Distribution(this, `${id}Distribution`, {
        comment: `stacks ${envTag(envName)} redirect ${old.rootDomain}`,
        // Never reached: the viewer-request function answers every request.
        defaultBehavior: {
          origin: new origins.HttpOrigin(`auth.${env.rootDomain}`, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.ALLOW_ALL,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          functionAssociations: [{ function: fn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
        },
        domainNames: names,
        certificate,
      });
      const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
      for (const [suffix, recordName] of records) {
        new route53.ARecord(this, `${id}${suffix}Record`, { zone, recordName, target });
        new route53.AaaaRecord(this, `${id}${suffix}RecordIpv6`, { zone, recordName, target });
      }
    }
  }
}
