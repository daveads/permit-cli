import { Permit } from 'permitio';
import { HCLGenerator, WarningCollector } from '../types.js';
import { createSafeId } from '../utils.js';
import Handlebars from 'handlebars';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface ConditionSetRuleData {
  key: string;
  userSet: string;
  resourceSet: string;
  permission: string;
}

interface ConditionSetRule {
  user_set: string;
  resource_set: string;
  permission: string;
}

export class ConditionSetGenerator implements HCLGenerator {
  name = 'condition set rules';
  private template: Handlebars.TemplateDelegate<{rules: ConditionSetRuleData[]}>;

  constructor(
    private permit: Permit,
    private warningCollector: WarningCollector,
  ) {
    this.template = Handlebars.compile(
      readFileSync(join(__dirname, '../templates/condition-set.hcl'), 'utf-8'),
    );
  }

  async generateHCL(): Promise<string> {
    try {
      // Get all rules by passing wildcard values for required fields
      const rules = await this.permit.api.conditionSetRules.list({
        userSetKey: '*',
        permissionKey: '*',
        resourceSetKey: '*'
      });
      
      if (!rules || !Array.isArray(rules) || rules.length === 0) {
        return '';
      }

      const validRules = rules.map((rule: ConditionSetRule) => {
        try {
          const cleanUserSet = rule.user_set.replace('__autogen_', '');
          const cleanResourceSet = rule.resource_set;

          const key = `allow_${cleanResourceSet}`;

          return {
            key: createSafeId(key),
            userSet: createSafeId(cleanUserSet),
            resourceSet: createSafeId(cleanResourceSet),
            permission: rule.permission,
          };
        } catch (ruleError) {
          this.warningCollector.addWarning(
            `Failed to export condition set rule: ${ruleError}`,
          );
          return null;
        }
      }).filter((rule): rule is ConditionSetRuleData => rule !== null);

      if (validRules.length === 0) return '';

      // Return generated HCL
      return '\n# Condition Set Rules\n' + this.template({ rules: validRules });
    } catch (error) {
      this.warningCollector.addWarning(
        `Failed to export condition set rules: ${error}`,
      );
      return '';
    }
  }
}