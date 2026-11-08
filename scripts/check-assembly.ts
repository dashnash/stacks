/**
 * Staging deploy gate, run by the credentialed job before `cdk deploy`:
 *   npx tsx scripts/check-assembly.ts <cdk.out dir> <expected stack name>
 */
import { checkAssembly } from '@stacks/infra';

const [dir, stack] = process.argv.slice(2);
if (!dir || !stack) {
  console.error('usage: check-assembly <cdk.out> <stack-name>');
  process.exit(2);
}
const problems = checkAssembly(dir, stack);
if (problems.length) {
  console.error(`Refusing to deploy:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`Assembly OK: only ${stack}, no forbidden IAM resources.`);
