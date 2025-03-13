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

	/**
	 * Process an individual condition set rule and convert it to the expected format
	 * Returns null if the rule should be skipped
	 */
	private processConditionSetRule(
		rule: ConditionSetRule,
		availableUserSets: Set<string>,
		availableResourceSets: Set<string>,
	): ConditionSetRuleData | null {
		try {
			// Extract user set and resource set keys
			const userSetKey = rule.user_set;
			const resourceSetKey = rule.resource_set;
			const permissionKey = rule.permission;

			// Check if this is an autogenerated user set
			const isUserSetAutogen = userSetKey.startsWith('__autogen_');
			if (isUserSetAutogen && !availableUserSets.has(userSetKey)) {
				return null;
			}

			// Check if this is an autogenerated resource set
			const isResourceSetAutogen = resourceSetKey.startsWith('__autogen_');
			if (isResourceSetAutogen && !availableResourceSets.has(resourceSetKey)) {
				return null;
			}

			// Create a unique identifier for this rule
			const ruleKey = `${createSafeId(userSetKey)}_${createSafeId(resourceSetKey)}_${createSafeId(permissionKey)}`;

			return {
				key: ruleKey,
				userSet: userSetKey,
				resourceSet: resourceSetKey,
				permission: permissionKey,
				isAutogenerated: isUserSetAutogen || isResourceSetAutogen,
			};
		} catch (error) {
			this.warningCollector.addWarning(
				`Failed to process condition set rule: ${error}`,
			);
			return null;
		}
	}

	async generateHCL(): Promise<string> {
		try {
			// Create base parameters for API call
			const baseParams: Record<string, string | number> = {
				tenant: '',
				subject: '',
				relation: '',
				object: '',
				objectType: '',
				subjectType: '',
			};

			// Implement pagination to fetch all condition set rules
			let allConditionSetRules: ConditionSetRule[] = [];
			let currentPage = 1;
			const perPage = 100;
			let hasMoreResults = true;

			// Fetch all pages of condition set rules
			while (hasMoreResults) {
				const params = {
					...baseParams,
					page: currentPage,
					perPage: perPage,
				};

				const conditionSetRulesAPI = this.permit.api
					.conditionSetRules as unknown as ConditionSetRulesAPI;
				const pageResults = await conditionSetRulesAPI.list(params);

				if (pageResults && pageResults.length > 0) {
					allConditionSetRules = [...allConditionSetRules, ...pageResults];
					// Check if we got a full page of results; if not, we've reached the end
					if (pageResults.length < perPage) {
						hasMoreResults = false;
					} else {
						currentPage++;
					}
				} else {
					hasMoreResults = false;
				}
			}

			// Get all condition sets first, then filter by type
			const allConditionSets = await this.permit.api.conditionSets.list();
			const userSets = allConditionSets.filter(set => set.type === 'userset');
			const resourceSets = allConditionSets.filter(
				set => set.type === 'resourceset',
			);

			// Create sets of available user and resource set keys for quick lookup
			const availableUserSets = new Set(userSets.map(set => set.key));
			const availableResourceSets = new Set(resourceSets.map(set => set.key));

			if (!allConditionSetRules || allConditionSetRules.length === 0) {
				return '';
			}

			// Process each rule using the extracted method
			const validRules = allConditionSetRules
				.map(rule =>
					this.processConditionSetRule(
						rule,
						availableUserSets,
						availableResourceSets,
					),
				)
				.filter((rule): rule is ConditionSetRuleData => rule !== null);

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
