import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

interface Template {
  Resources?: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
}

/**
 * The deploy job's gate for staging (see the spec's "Staging deploys without AWS credentials"):
 * the cloud assembly built from a branch may contain only the one expected app stack, and it may
 * not create IAM users, access keys or policies outside the staging rules. Returns the problems
 * found (empty = OK to deploy).
 */
export function checkAssembly(assemblyDir: string, expectedStack: string): string[] {
  const problems: string[] = [];
  const manifest = JSON.parse(readFileSync(path.join(assemblyDir, 'manifest.json'), 'utf8')) as {
    artifacts?: Record<string, { type: string; properties?: { templateFile?: string; stackName?: string } }>;
  };
  const stacks = Object.entries(manifest.artifacts ?? {}).filter(([, a]) => a.type === 'aws:cloudformation:stack');
  const names = stacks.map(([id, a]) => a.properties?.stackName ?? id);
  if (names.length !== 1 || names[0] !== expectedStack) {
    problems.push(`assembly must contain exactly the stack ${expectedStack}, found: ${names.join(', ') || 'none'}`);
  }
  const forbiddenTypes = new Set(['AWS::IAM::User', 'AWS::IAM::AccessKey', 'AWS::IAM::Group', 'AWS::IAM::ManagedPolicy', 'AWS::IAM::OIDCProvider', 'AWS::IAM::SAMLProvider']);
  for (const [id, artifact] of stacks) {
    const file = artifact.properties?.templateFile;
    if (!file) continue;
    const template = JSON.parse(readFileSync(path.join(assemblyDir, file), 'utf8')) as Template;
    for (const [logicalId, res] of Object.entries(template.Resources ?? {})) {
      if (forbiddenTypes.has(res.Type)) problems.push(`${id}/${logicalId}: ${res.Type} is not allowed in app stacks`);
      if (res.Type === 'AWS::IAM::Role' && !res.Properties?.PermissionsBoundary) {
        problems.push(`${id}/${logicalId}: IAM role without the staging permissions boundary`);
      }
    }
  }
  // Nested assemblies (stages) could hide more stacks.
  if (readdirSync(assemblyDir).some((f) => f.startsWith('assembly-'))) problems.push('nested assemblies are not allowed');
  return problems;
}
