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
	isAutogenerated: boolean;
}

interface ConditionSetRule {
	user_set: string;
	resource_set: string;
	permission: string;
	id?: string;
	key?: string;
	organization_id?: string;
	project_id?: string;
	environment_id?: string;
	created_at?: string;
	updated_at?: string;
	[key: string]: string | undefined;
}

interface ConditionSetRulesAPI {
	list(params: Record<string, string | number>): Promise<ConditionSetRule[]>;
}

export class ConditionSetGenerator implements HCLGenerator {
	name = 'condition set rules';
	private template: Handlebars.TemplateDelegate<{
		rules: ConditionSetRuleData[];
	}>;

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
			// Create the parameters object
			const params: Record<string, string | number> = {
				tenant: '',
				subject: '',
				relation: '',
				object: '',
				objectType: '',
				subjectType: '',
				page: 1,
				perPage: 100,
			};

			const conditionSetRulesAPI = this.permit.api
				.conditionSetRules as unknown as ConditionSetRulesAPI;
			const conditionSetRules = await conditionSetRulesAPI.list(params);

			const userSets = await this.permit.api.conditionSets.list();

			// Create a set of available user set keys for quick lookup
			const availableUserSets = new Set(userSets.map(set => set.key));

			if (!conditionSetRules || conditionSetRules.length === 0) {
				return '';
			}

			// Process each rule to create the HCL data
			const validRules = conditionSetRules
				.map((rule: ConditionSetRule) => {
					try {
						// Extract user set and resource set keys
						const userSetKey = rule.user_set;
						const resourceSetKey = rule.resource_set;
						const permissionKey = rule.permission;

						// Check if this is an autogenerated user set
						const isAutogenerated = userSetKey.startsWith('__autogen_');

						// Skip autogenerated user sets that don't exist in the environment
						if (isAutogenerated && !availableUserSets.has(userSetKey)) {
							this.warningCollector.addWarning(
								`Skipping condition set rule referencing non-existent user set: ${userSetKey}`,
							);
							return null;
						}

						// Create a unique identifier for this rule
						const ruleKey = `${createSafeId(userSetKey)}_${createSafeId(resourceSetKey)}_${createSafeId(permissionKey)}`;

						return {
							key: ruleKey,
							userSet: createSafeId(userSetKey),
							resourceSet: createSafeId(resourceSetKey),
							permission: permissionKey,
							isAutogenerated,
						};
					} catch (error) {
						this.warningCollector.addWarning(
							`Failed to process condition set rule: ${error}`,
						);
						return null;
					}
				})
				.filter(
					(rule: ConditionSetRuleData | null): rule is ConditionSetRuleData =>
						rule !== null,
				);

			if (validRules.length === 0) {
				return '';
			}

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
