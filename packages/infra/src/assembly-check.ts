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
  // Assets: the deploy job publishes them next to AWS credentials, so nothing in the assembly may
  // make it run a command of the branch's choosing. App stacks have plain file assets only (the
  // Lambdas' code, the web build, a game server's bundle): no image, and no file built by a command.
  for (const name of readdirSync(assemblyDir).filter((f) => f.endsWith('.assets.json'))) {
    const assets = JSON.parse(readFileSync(path.join(assemblyDir, name), 'utf8')) as {
      files?: Record<string, { source?: { executable?: unknown } }>;
      dockerImages?: Record<string, unknown>;
    };
    for (const [id, file] of Object.entries(assets.files ?? {})) {
      if (file.source?.executable) problems.push(`${name}/${id}: file assets may not run a command`);
    }
    for (const id of Object.keys(assets.dockerImages ?? {})) {
      problems.push(`${name}/${id}: app stacks have no container images (game servers run the platform's pinned Node image)`);
    }
  }
  // Nested assemblies (stages) could hide more stacks.
  if (readdirSync(assemblyDir).some((f) => f.startsWith('assembly-'))) problems.push('nested assemblies are not allowed');
  return problems;
}
