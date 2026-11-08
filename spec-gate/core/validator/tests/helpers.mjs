// 文件：helpers.mjs
// 描述：core JS 测试共享设施（CORE_ROOT/SCHEMAS_DIR/MANIFEST_PATH/loadJson）。
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CORE_ROOT = resolve(HERE, '../..');
export const SCHEMAS_DIR = join(CORE_ROOT, 'schemas');
export const MANIFEST_PATH = join(CORE_ROOT, 'manifest.json');

export function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export const REQUIRED_MANIFEST_FIELDS = [
  'schemaVersion', 'compatibilityRange', 'publicAssets', 'ruleRegistry',
  'deprecationMappings', 'retiredRuleIds',
];
export const PUBLIC_ASSET_FIELDS = ['assetId', 'kind', 'path', 'version', 'sha256', 'deprecated', 'supersededBy'];
export const RULE_FIELDS = ['ruleId', 'owner', 'severity', 'appliesWhen', 'statement', 'checkMethod', 'evidenceRequired', 'failureAction', 'waiverPolicy'];
export const BLOCKING_QUAD = ['checkMethod', 'evidenceRequired', 'failureAction', 'waiverPolicy'];
export const SEVERITIES = ['blocking', 'warning', 'guidance'];
export const OWNERS = ['sdd-ddd-tdd', 'spec-backfill', 'spec-writing', 'sdd-methodology-core'];
export const ALLOWED_DOMAINS = [
  'CORE', 'SPEC', 'DDD', 'TDD', 'FAST', 'OPT', 'BACKFILL', 'ADR', 'OPEN', 'PATH',
  'PACK', 'MIG', 'HOST', 'ROUTE', 'FLOW', 'PROJ', 'LEDGER', 'EVID', 'BOUND', 'IF', 'PLAN',
];
export const GATE_REPORT_FIELDS = [
  'schemaVersion', 'taskId', 'generatedAt', 'finalStatus', 'applicability', 'preferences',
  'prerequisites', 'gates', 'artifactsChanged', 'domainChanges', 'tddCycles', 'validationRuns',
  'confirmations', 'waivers', 'unverifiedItems', 'openItems', 'residualRisks',
];
export const FINAL_STATUSES = ['complete', 'partial', 'blocked', 'temporary-mitigation'];
export const GATE_STATUSES = ['passed', 'failed', 'not-applicable', 'waived', 'unverified'];
export const ADR_STATUSES = ['proposed', 'accepted', 'deprecated', 'superseded', 'rejected'];
export const CONFIRMATION_STATUSES = ['pending', 'confirmed', 'rejected', 'not-required'];
export const WAIVER_STATUSES = ['active', 'expired', 'revoked'];
export const ACCEPTANCE_STATUSES = ['passed', 'failed', 'unverified', 'error', 'not-applicable'];
export const MIGRATION_STATUSES = ['migrated', 'deleted', 'pending-delete'];
export const COMMAND_EVIDENCE_FIELDS = ['command', 'workingDirectory', 'selectionCriteria', 'exitCode', 'executedAt', 'keyOutputSummary'];
export const HOST_FORBIDDEN_SUBSTRINGS = ['.zcode', 'zcode', 'claude', 'cursor', 'mcp__', 'copilot', 'gemini-cli'];
